import english from '../../locales/en.json'
let translate: ((key: string, params?: Record<string, string | number>) => string) | undefined
export function setTranslator(value: typeof translate): void { translate = value }
export function createTranslator(value: typeof translate) {
  return (key: string, params?: Record<string, string | number>): string => {
    if (value) return value(key, params)
    return ((english as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? `{{${name}}}`))
  }
}
const fallback = createTranslator(undefined)
export function t(key: string, params?: Record<string, string | number>): string { return (translate ?? fallback)(key, params) }
