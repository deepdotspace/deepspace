import type { ReactElement, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      {...props}
    >
      {children}
    </svg>
  )
}

export function OrbitMark(props: IconProps): ReactElement {
  return (
    <Icon viewBox="0 0 32 32" {...props}>
      <path d="M16 2.5c.5 7.7 5.8 13 13.5 13.5-7.7.5-13 5.8-13.5 13.5C15.5 21.8 10.2 16.5 2.5 16 10.2 15.5 15.5 10.2 16 2.5Z" fill="currentColor" />
      <circle cx="16" cy="16" fill="var(--documentation-bg)" r="3.25" />
      <path d="M4.5 22.7c5.6-2 16.4-8.3 22.7-14.1" opacity=".45" stroke="currentColor" strokeLinecap="round" />
    </Icon>
  )
}

export function SearchIcon(props: IconProps): ReactElement {
  return <Icon {...props}><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" /><path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /></Icon>
}

export function SparkIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="M12 2.8c.3 5 3.7 8.4 8.7 8.7-5 .3-8.4 3.7-8.7 8.7-.3-5-3.7-8.4-8.7-8.7 5-.3 8.4-3.7 8.7-8.7Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" /><path d="M19 3v4M21 5h-4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" /></Icon>
}

export function MenuIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /></Icon>
}

export function CloseIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /></Icon>
}

export function SunIcon(props: IconProps): ReactElement {
  return <Icon {...props}><circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></Icon>
}

export function MoonIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="M19.5 14.8A8 8 0 0 1 9.2 4.5 8 8 0 1 0 19.5 14.8Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" /></Icon>
}

export function SystemIcon(props: IconProps): ReactElement {
  return <Icon {...props}><rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 21h8M12 17v4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></Icon>
}

export function ChevronRightIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="m9 5 7 7-7 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></Icon>
}

export function ChevronDownIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="m5 9 7 7 7-7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></Icon>
}

export function ExternalIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="M14 4h6v6M20 4l-9 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></Icon>
}

export function CopyIcon(props: IconProps): ReactElement {
  return <Icon {...props}><rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.6" /></Icon>
}

export function CheckIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="m5 12.5 4.2 4L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" /></Icon>
}

export function FileIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" /><path d="M14 3.5v4h4M8 12h7M8 16h7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></Icon>
}

export function MessageIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="M5.5 18.5 4 21l3.5-1.2A8.5 8.5 0 1 0 5.5 18.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" /><path d="M8 10h8M8 14h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></Icon>
}

export function TerminalIcon(props: IconProps): ReactElement {
  return <Icon {...props}><rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="m7 9 3 3-3 3M12.5 15H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" /></Icon>
}

export function EditorIcon(props: IconProps): ReactElement {
  return <Icon {...props}><rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 4.5v15M11.5 9h5M11.5 12h5M11.5 15h3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></Icon>
}

export function SendIcon(props: IconProps): ReactElement {
  return <Icon {...props}><path d="M12 18V6M7.5 10.5 12 6l4.5 4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></Icon>
}

export function StopIcon(props: IconProps): ReactElement {
  return <Icon {...props}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></Icon>
}
