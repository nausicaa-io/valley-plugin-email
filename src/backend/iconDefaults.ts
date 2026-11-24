// Bundled Email grouping icons, seeded into .valley/assets/icons/email-icon/ without overwriting saved files.
// Every SVG matches the shared Valley 24x24 monochrome stroke style (calendar-icon, contact-icon, todo-icon).
const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const DEFAULT_EMAIL_ICONS: Record<string, string> = {
  'alert-circle': svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
  archive: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>'),
  banknote: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  bookmark: svg('<path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z"/>'),
  briefcase: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M3 12.5h18"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'),
  code: svg('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  'credit-card': svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>'),
  'file-text': svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>'),
  gift: svg('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>'),
  'graduation-cap': svg('<path d="M2 9.5 12 5l10 4.5-10 4.5z"/><path d="M6 11.5v4.5c0 1.4 2.7 3 6 3s6-1.6 6-3v-4.5"/><path d="M22 9.5v5"/>'),
  heart: svg('<path d="M12 20s-8-4.8-8-10.2A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.8C20 15.2 12 20 12 20z"/>'),
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11h14V9"/><path d="M10 20v-6h4v6"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.5"/><path d="m21 15-4.5-4.5L7 20"/>'),
  inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>'),
  megaphone: svg('<path d="m3 11 14-5v12L3 13v-2z"/><path d="M17 9a3 3 0 0 1 0 6"/><path d="M7 14v4a1 1 0 0 0 1 1h2"/>'),
  'message-square': svg('<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  newspaper: svg('<path d="M4 20h15a2 2 0 0 0 2-2V5a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v13a2 2 0 0 1-2 2z"/><path d="M6 12H4a1 1 0 0 0-1 1v5a2 2 0 0 0 2 2"/><path d="M10 8h7"/><path d="M10 12h7"/><path d="M10 16h4"/>'),
  package: svg('<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/><path d="m8 5.25 8 4.5"/>'),
  percent: svg('<path d="M19 5 5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>'),
  plane: svg('<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>'),
  receipt: svg('<path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2z"/><path d="M9 7.5h6"/><path d="M9 11.5h6"/><path d="M9 15.5h3"/>'),
  repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.4 8.2 8 9.5 4.6-1.3 8-4.5 8-9.5V6l-8-3z"/>'),
  'shopping-bag': svg('<path d="M6 7h12l1 13H5L6 7z"/><path d="M9 7V6a3 3 0 0 1 6 0v1"/>'),
  sparkles: svg('<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"/><path d="M19 3v3M20.5 4.5h-3M5 17v3M6.5 18.5h-3"/>'),
  star: svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>'),
  tag: svg('<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  train: svg('<rect x="5" y="3" width="14" height="14" rx="2"/><path d="M5 11h14"/><path d="M12 3v8"/><path d="m8 17-2 4"/><path d="m16 17 2 4"/><path d="M9 14h.01M15 14h.01"/>'),
  truck: svg('<path d="M14 18V6H3v12h2"/><path d="M14 9h4l3 3v6h-2"/><circle cx="7.5" cy="18" r="2"/><circle cx="16.5" cy="18" r="2"/><path d="M9.5 18h5"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4.5 21v-1a6 6 0 0 1 6-6h3a6 6 0 0 1 6 6v1"/>'),
  users: svg('<circle cx="8" cy="7" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20v-1.5A4.5 4.5 0 0 1 7 14h2a4.5 4.5 0 0 1 4.5 4.5V20"/><path d="M15 14.5h2.5A4 4 0 0 1 21.5 18.5V20"/>'),
  utensils: svg('<path d="M5 3v7a2 2 0 0 0 4 0V3"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M17 3a3 3 0 0 1 3 3v5a2 2 0 0 1-2 2h-1"/>')
}
