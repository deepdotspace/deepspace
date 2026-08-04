import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react'
import { Children, createElement, isValidElement } from 'react'

interface TitledProps {
  children?: ReactNode
  label?: string
  title?: string
}

function Callout({ children, title, kind }: TitledProps & { kind: string }): ReactElement {
  const label = title ?? kind.charAt(0).toUpperCase() + kind.slice(1)
  return <aside className={`docs-callout docs-callout-${kind}`}><strong>{label}</strong>{children}</aside>
}

export function Note(props: TitledProps): ReactElement {
  return <Callout {...props} kind="note" />
}

export function Tip(props: TitledProps): ReactElement {
  return <Callout {...props} kind="tip" />
}

export function Warning(props: TitledProps): ReactElement {
  return <Callout {...props} kind="warning" />
}

export function Info(props: TitledProps): ReactElement {
  return <Callout {...props} kind="info" />
}

export function Card({ children, href, label, title }: TitledProps & { href?: string }): ReactElement {
  const content = <>{title ?? label ? <strong>{title ?? label}</strong> : null}{children}</>
  return href
    ? <a className="docs-card" href={href}>{content}<span aria-hidden="true">→</span></a>
    : <div className="docs-card">{content}</div>
}

export function Accordion({ children, label, title }: TitledProps): ReactElement {
  return <details className="docs-accordion"><summary>{title ?? label ?? 'Details'}</summary>{children}</details>
}

export function AccordionGroup({ children }: TitledProps): ReactElement {
  return <div className="docs-accordion-group">{children}</div>
}

export function Step({ children, label, title }: TitledProps): ReactElement {
  return <section className="docs-step">{title ?? label ? <h3>{title ?? label}</h3> : null}{children}</section>
}

export function Steps({ children }: TitledProps): ReactElement {
  return <div className="docs-steps">{children}</div>
}

export function Tab({ children, label, title }: TitledProps): ReactElement {
  return <section className="docs-tab" data-tab data-tab-title={title ?? label ?? 'Tab'}>{children}</section>
}

export function Tabs({ children }: TitledProps): ReactElement {
  return <div className="docs-tabs" data-tab-group>{children}</div>
}

export function CodeGroup({ children, label, title }: TitledProps): ReactElement {
  return (
    <div className="docs-code-group" data-tab-group>
      {title ?? label ? <div className="docs-code-group-title">{title ?? label}</div> : null}
      {Children.toArray(children).map((child, index) => (
        <section
          className="docs-tab"
          data-tab
          data-tab-title={codeBlockTitle(child) ?? `Example ${index + 1}`}
          key={index}
        >
          {child}
        </section>
      ))}
    </div>
  )
}

function codeBlockTitle(node: ReactNode): string | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined
  const code = node.props.children
  if (!isValidElement<Record<string, unknown>>(code)) return undefined
  const title = code.props['data-code-title']
  return typeof title === 'string' && title ? title : undefined
}

function Heading({ level, ...props }: ComponentPropsWithoutRef<'h2'> & { level: number }): ReactElement {
  const id = props.id
  return createElement(
    `h${level}`,
    props,
    props.children,
    id ? <a aria-label="Link to this section" className="docs-heading-anchor" href={`#${id}`}>#</a> : null,
  )
}

export const docsMdxComponents = {
  Accordion,
  AccordionGroup,
  Card,
  CodeGroup,
  Info,
  Note,
  Step,
  Steps,
  Tab,
  Tabs,
  Tip,
  Warning,
  h1: (props: ComponentPropsWithoutRef<'h1'>) => <Heading {...props} level={1} />,
  h2: (props: ComponentPropsWithoutRef<'h2'>) => <Heading {...props} level={2} />,
  h3: (props: ComponentPropsWithoutRef<'h3'>) => <Heading {...props} level={3} />,
  h4: (props: ComponentPropsWithoutRef<'h4'>) => <Heading {...props} level={4} />,
  h5: (props: ComponentPropsWithoutRef<'h5'>) => <Heading {...props} level={5} />,
  h6: (props: ComponentPropsWithoutRef<'h6'>) => <Heading {...props} level={6} />,
}
