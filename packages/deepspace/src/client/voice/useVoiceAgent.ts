/**
 * useVoiceAgent - managed browser voice on OpenAI Realtime, zero config.
 *
 * The hook mints a credit-gated ephemeral token via our proxy
 * (`openai-realtime/create-session`), connects the browser to OpenAI over raw
 * WebRTC, and on teardown reports the elapsed duration to
 * `openai-realtime/settle-session` so the user is billed for actual minutes. A
 * client timer stops the call at `maxMinutes` (OpenAI also hard-disconnects at
 * 60). The developer holds no key and writes no WebRTC.
 *
 * Billing note: settle is best-effort. If it never lands (crash, offline), the
 * server cron settles the session to the reserved cap - so the platform never
 * loses money; the hook's settle just refines DOWN to actual minutes and
 * releases a never-started session immediately.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { integration } from '../integration'

const OPENAI_REALTIME_BASE = 'https://api.openai.com/v1'

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'ended' | 'error'

export interface VoiceTranscriptEntry {
  role: 'user' | 'assistant'
  content: string
}

export interface UseVoiceAgentOptions {
  instructions?: string
  voice?: string
  /** OpenAI tool definitions, passed through to the session. */
  tools?: Record<string, unknown>[]
  /** Hard cap; the hook stops the call at this many minutes. */
  maxMinutes?: number
  /** Called when the model invokes a tool; the return value is sent back. */
  onToolCall?: (name: string, args: unknown) => Promise<unknown> | unknown
}

export interface UseVoiceAgentResult {
  status: VoiceStatus
  start: (overrides?: Partial<UseVoiceAgentOptions>) => Promise<void>
  stop: () => Promise<void>
  isMuted: boolean
  toggleMute: () => void
  isAgentSpeaking: boolean
  transcript: VoiceTranscriptEntry[]
  error: string | null
  /** Escape hatches for advanced use. */
  pc: RTCPeerConnection | null
  dataChannel: RTCDataChannel | null
}

const ZERO_USAGE = { inputAudioTokens: 0, outputAudioTokens: 0, inputTextTokens: 0, outputTextTokens: 0 }

/** Token accounting block within a Realtime `response.done` event. */
interface RealtimeTokenDetails {
  audio_tokens?: number
  text_tokens?: number
}

/** A single output item within a Realtime response (e.g. a function call). */
interface RealtimeOutputItem {
  type?: string
  name?: string
  call_id?: string
  arguments?: string
}

/**
 * Loosely-typed OpenAI Realtime wire event. Only the fields this hook reads are
 * modeled; everything else is left off since the protocol is large and dynamic.
 */
interface RealtimeEvent {
  type?: string
  delta?: string
  transcript?: string
  response?: {
    usage?: {
      input_token_details?: RealtimeTokenDetails
      output_token_details?: RealtimeTokenDetails
    }
    output?: RealtimeOutputItem[]
  }
}

export function useVoiceAgent(options: UseVoiceAgentOptions = {}): UseVoiceAgentResult {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [isMuted, setIsMuted] = useState(false)
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false)
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const liveStartRef = useRef<number | null>(null)
  const settledRef = useRef(false)
  const usageRef = useRef({ ...ZERO_USAGE })

  // Keep the latest options without re-creating callbacks (onToolCall etc).
  const optsRef = useRef(options)
  optsRef.current = options

  const settle = useCallback(async () => {
    const sessionId = sessionIdRef.current
    if (!sessionId || settledRef.current) return
    settledRef.current = true
    const durationSeconds = liveStartRef.current ? Math.max(0, (Date.now() - liveStartRef.current) / 1000) : 0
    try {
      await integration.post('openai-realtime/settle-session', {
        sessionId,
        durationSeconds,
        usage: usageRef.current,
      })
    } catch {
      // Best-effort: the server cron settles to the cap if this never lands.
    }
  }, [])

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    try {
      dcRef.current?.close()
    } catch {
      // ignore
    }
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    } catch {
      // ignore
    }
    try {
      if (pcRef.current) pcRef.current.onconnectionstatechange = null
      pcRef.current?.close()
    } catch {
      // ignore
    }
    if (audioRef.current) audioRef.current.srcObject = null
    dcRef.current = null
    pcRef.current = null
    streamRef.current = null
    audioRef.current = null
  }, [])

  const stop = useCallback(async () => {
    cleanup()
    await settle()
    setIsAgentSpeaking(false)
    setStatus((s) => (s === 'error' ? s : 'ended'))
  }, [cleanup, settle])

  const appendTranscript = useCallback((role: 'user' | 'assistant', delta: string) => {
    if (!delta) return
    setTranscript((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === role) return [...prev.slice(0, -1), { role, content: last.content + delta }]
      return [...prev, { role, content: delta }]
    })
  }, [])

  // Tool-call round-trip: run the dev's handler, send the output back, ask for the
  // next response. Event field names track the current Realtime API; adjust here
  // if OpenAI renames them.
  const handleToolCall = useCallback(async (item: { name?: string; call_id?: string; arguments?: string }) => {
    const onToolCall = optsRef.current.onToolCall
    let output: unknown = null
    if (onToolCall && item.name) {
      let args: unknown = {}
      try {
        args = item.arguments ? JSON.parse(item.arguments) : {}
      } catch {
        args = {}
      }
      try {
        output = await onToolCall(item.name, args)
      } catch (e) {
        output = { error: e instanceof Error ? e.message : String(e) }
      }
    }
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    dc.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output ?? null) },
      }),
    )
    dc.send(JSON.stringify({ type: 'response.create' }))
  }, [])

  const handleEvent = useCallback(
    (raw: unknown) => {
      if (typeof raw !== 'string') return
      // OpenAI Realtime events are a large, dynamic wire protocol with deeply
      // nested optional fields; model as a loose record and read fields defensively.
      let ev: RealtimeEvent
      try {
        ev = JSON.parse(raw) as RealtimeEvent
      } catch {
        return
      }
      switch (ev.type) {
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta':
          appendTranscript('assistant', ev.delta ?? '')
          break
        case 'conversation.item.input_audio_transcription.completed':
          appendTranscript('user', ev.transcript ?? '')
          break
        case 'output_audio_buffer.started':
          setIsAgentSpeaking(true)
          break
        case 'output_audio_buffer.stopped':
          setIsAgentSpeaking(false)
          break
        case 'response.done': {
          const u = ev.response?.usage
          if (u) {
            usageRef.current.inputAudioTokens += u.input_token_details?.audio_tokens ?? 0
            usageRef.current.outputAudioTokens += u.output_token_details?.audio_tokens ?? 0
            usageRef.current.inputTextTokens += u.input_token_details?.text_tokens ?? 0
            usageRef.current.outputTextTokens += u.output_token_details?.text_tokens ?? 0
          }
          for (const item of ev.response?.output ?? []) {
            if (item?.type === 'function_call') void handleToolCall(item)
          }
          break
        }
      }
    },
    [appendTranscript, handleToolCall],
  )

  const start = useCallback(
    async (overrides: Partial<UseVoiceAgentOptions> = {}) => {
      // A second start() while a session is in flight (re-click / re-trigger) must
      // not abandon the prior one: settle + tear it down first, else its sessionId
      // is lost (the cron bills it at the full cap) and its mic/peer/timer leak.
      if (sessionIdRef.current) {
        cleanup()
        await settle()
      }
      const o = { ...optsRef.current, ...overrides }
      setError(null)
      setTranscript([])
      setIsAgentSpeaking(false)
      setStatus('connecting')
      settledRef.current = false
      liveStartRef.current = null
      sessionIdRef.current = null
      usageRef.current = { ...ZERO_USAGE }

      try {
        const res = await integration.post<{ sessionId: string; clientSecret: string; model: string; maxMinutes: number }>(
          'openai-realtime/create-session',
          { instructions: o.instructions, voice: o.voice, tools: o.tools, maxMinutes: o.maxMinutes },
        )
        if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to start voice session')
        const { sessionId, clientSecret, model, maxMinutes } = res.data
        sessionIdRef.current = sessionId

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream

        const pc = new RTCPeerConnection()
        pcRef.current = pc
        // End + settle on a real connection drop (failed/closed) rather than waiting
        // for the maxMinutes timer, so a dropped call bills connected time, not the
        // cap. 'disconnected' is transient (may recover) so it is not acted on.
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') void stop()
        }
        const audio = new Audio()
        audio.autoplay = true
        audioRef.current = audio
        pc.ontrack = (e) => {
          audio.srcObject = e.streams[0]
        }
        stream.getTracks().forEach((t) => pc.addTrack(t, stream))

        const dc = pc.createDataChannel('oai-events')
        dcRef.current = dc
        dc.onmessage = (e) => handleEvent(e.data)

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const sdpRes = await fetch(`${OPENAI_REALTIME_BASE}/realtime/calls?model=${encodeURIComponent(model)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        })
        if (!sdpRes.ok) throw new Error(`Realtime connect failed (${sdpRes.status})`)
        const answer = await sdpRes.text()
        await pc.setRemoteDescription({ type: 'answer', sdp: answer })

        liveStartRef.current = Date.now()
        setStatus('live')
        timerRef.current = setTimeout(() => void stop(), (maxMinutes ?? 30) * 60_000)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
        cleanup()
        // Release the reservation immediately (durationSeconds = 0 if never live).
        await settle()
      }
    },
    [cleanup, settle, stop, handleEvent],
  )

  const toggleMute = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    setIsMuted((muted) => {
      const next = !muted
      stream.getAudioTracks().forEach((t) => (t.enabled = !next))
      return next
    })
  }, [])

  // Settle + tear down on unmount so a closed tab never leaves a dangling session.
  useEffect(() => {
    return () => {
      cleanup()
      void settle()
    }
  }, [cleanup, settle])

  return {
    status,
    start,
    stop,
    isMuted,
    toggleMute,
    isAgentSpeaking,
    transcript,
    error,
    pc: pcRef.current,
    dataChannel: dcRef.current,
  }
}
