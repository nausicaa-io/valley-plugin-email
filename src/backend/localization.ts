import english from '../../locales/en.json'
let translate: ((key: string, params?: Record<string, string | number>) => string) | undefined
export function setTranslator(value: typeof translate): void { translate = value }
export function t(key: string, params?: Record<string, string | number>): string {
  if (translate) return translate(key, params)
  return ((english as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? `{{${name}}}`))
}
