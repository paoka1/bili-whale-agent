// 日记与时间线里的文字来自陌生人评论、弹幕、标题，渲染前必须消毒。
import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function Markdown({ source }: { source: string }) {
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }))
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
