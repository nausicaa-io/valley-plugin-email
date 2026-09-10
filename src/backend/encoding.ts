export function encodeBytes(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(value)
}

export function decodeBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

export function encodeText(value: string): string {
  return encodeBytes(new TextEncoder().encode(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeText(value: string): string {
  return new TextDecoder().decode(decodeBytes(value.replace(/-/g, '+').replace(/_/g, '/')))
}
