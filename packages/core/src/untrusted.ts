const escapeMarkers = (text: string) => text.replaceAll('<<<', '《《《').replaceAll('>>>', '》》》')

/** 外部内容不能自行关闭包装；来源标签也不允许插入标记或引号。 */
export function wrapUntrusted(source: string, text: string): string {
  const label = escapeMarkers(source).replace(/["\r\n]/g, ' ')
  return `<<<UNTRUSTED source="${label}">>>\n${escapeMarkers(text)}\n<<<END_UNTRUSTED>>>`
}
