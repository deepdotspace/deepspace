import { describe, expect, it } from 'vitest'
import { compile } from '@mdx-js/mdx'
import { parseCodeFenceInfo, parseMarkdown } from '../markdown'
import { mdxCompileOptions } from '../mdx'

describe('code fence titles', () => {
  it('treats bare metadata as a title unless it is an option shape', () => {
    expect(parseCodeFenceInfo('bash .dev.vars').title).toBe('.dev.vars')
    expect(parseCodeFenceInfo('ts src/worker.ts').title).toBe('src/worker.ts')
    expect(parseCodeFenceInfo('js title="Config file"').title).toBe('Config file')
    // Bare words are valid titles — they label code-group tabs (npm/pnpm).
    expect(parseCodeFenceInfo('bash npm').title).toBe('npm')
    // Option shapes must never render as a header bar.
    expect(parseCodeFenceInfo('js {1,3-4}').title).toBeUndefined()
    expect(parseCodeFenceInfo('js wrap').title).toBeUndefined()
    expect(parseCodeFenceInfo('bash expandable').title).toBeUndefined()
    expect(parseCodeFenceInfo('ts focus').title).toBeUndefined()
  })

  it('emits data-code-title on the Markdown path for filenames only', () => {
    const titled = parseMarkdown('```bash .dev.vars\necho hi\n```\n', 'fence.md')
    expect(titled.html).toContain('data-code-title=".dev.vars"')
    const options = parseMarkdown('```js {1,3-4}\nconst a = 1\n```\n', 'fence.md')
    expect(options.html).not.toContain('data-code-title')
  })

  it('emits data-code-title on the executable MDX path with the same grammar', async () => {
    const titled = String(await compile('```bash .dev.vars\necho hi\n```\n', mdxCompileOptions()))
    expect(titled).toContain('"data-code-title": ".dev.vars"')
    const options = String(await compile('```js {1,3-4}\nconst a = 1\n```\n', mdxCompileOptions()))
    expect(options).not.toContain('data-code-title')
  })
})
