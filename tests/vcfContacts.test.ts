import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import type { AiClassificationRequest, AiClassificationResult } from '@valley/plugin-sdk/ai'
import config from '../config.json'
import { formatVcfContactForAi, parseVcfFile } from '../src/vcfContacts'
import { buildClassificationInput, cleanTextForClassification, createClassificationQueue } from '../src/classificationQueue'
import { accountRevision, createSmartGroupsStore, decideSmartGroup, groupDisplayIcon, normalizeSmartGroups, type SmartGroup } from '../src/smartGroups'
import { emailStoreContext, mergeFolder } from '../src/backend/cache'
import { readEmailIcons } from '../src/backend/icons'
import { DEFAULT_EMAIL_ICONS } from '../src/backend/iconDefaults'
import { sanitizeEmailSvg } from '../src/emailIcons'

const disposers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

describe('VCF contact parsing and Jev AI enrichment', () => {
  it('parses vCard fields including name, org, groups, relations, email labels and skips large PHOTO payloads', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:urn:uuid:1111',
      'FN:Birk Fernwood',
      'N:Fernwood;Birk;;;',
      'NICKNAME:Birky',
      'EMAIL;TYPE=family,pref:birk@fernwood.example',
      'item1.EMAIL:birk@studio.example',
      'item1.X-ABLabel:_$!<Work>!$_',
      'ORG:Fernwood Studio;Design',
      'TITLE:Lead Designer',
      'CATEGORIES:Family,Close',
      'RELATED;TYPE=brother:Aster Fernwood',
      'PHOTO;ENCODING=b;TYPE=JPEG:' + 'A'.repeat(10000),
      ' ' + 'B'.repeat(10000),
      'NOTE:Calls every Sunday evening.',
      'END:VCARD'
    ].join('\r\n')

    const parsed = parseVcfFile('.archive/contacts/Birk Fernwood.vcf', raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      id: 'vcf:urn:uuid:1111',
      displayName: 'Birk Fernwood',
      firstName: 'Birk',
      lastName: 'Fernwood',
      nickname: 'Birky',
      emails: [
        { address: 'birk@fernwood.example', label: 'family' },
        { address: 'birk@studio.example', label: 'work' }
      ],
      organizations: [{ name: 'Fernwood Studio', department: 'Design', title: 'Lead Designer' }],
      groups: ['Family', 'Close'],
      relations: [{ type: 'brother', to: 'Aster Fernwood' }],
      note: 'Calls every Sunday evening.'
    })

    const profile = formatVcfContactForAi(parsed, 'birk@fernwood.example')
    expect(profile).toEqual({
      known: true,
      name: 'Birk Fernwood',
      nickname: 'Birky',
      emailLabel: 'family',
      organizations: ['Fernwood Studio — Lead Designer — Design'],
      groups: ['Family', 'Close'],
      relations: ['brother'],
      note: 'Calls every Sunday evening.'
    })
  })

  it('cleans HTML entities, scripts and zero-width spacers and detects automated/unsubscribe signals for Jev AI', () => {
    const html = '<html><head><style>.x{color:red}</style></head><body><div>&#8203;&nbsp;50% OFF&#8203; Summer Sale &amp; Deals!</div><a href="#">Unsubscribe</a></body></html>'
    expect(cleanTextForClassification('', html)).toBe('50% OFF Summer Sale & Deals! Unsubscribe')

    const input = JSON.parse(buildClassificationInput({
      from: 'Deals <promo@shop.example>',
      to: 'me@example.test',
      subject: 'Weekend Flash Sale - 50% off',
      html,
      hasAttachments: false
    }, 'promo@shop.example'))

    expect(input).toMatchObject({
      sender: 'Deals <promo@shop.example>',
      senderDomain: 'shop.example',
      subject: 'Weekend Flash Sale - 50% off',
      hasAttachments: false,
      signals: { automatedSender: true, hasUnsubscribe: true },
      senderContact: { known: false }
    })
  })

  it('passes enriched VCF contact details into api.ai.classify for Jev AI sorting', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'canopy-mail', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
    mock.api.ai.defaults = vi.fn(async () => ({ classification: { provider: 'jev', connectionId: 'jev', model: 'jev-1.13.0' } }))
    await mergeFolder(emailStoreContext(mock.api.data), 'forest', 'INBOX', [{
      uid: 1,
      messageId: '<family-1@example.test>',
      from: 'birk@fernwood.example',
      to: 'forest@example.test',
      subject: 'Sunday dinner?',
      date: '2026-11-23T12:00:00.000Z',
      text: 'Want to come over at 7?',
      snippet: '',
      flags: [],
      hasAttachments: false
    }])
    const ids = mock.datasets.get('canopy-mail.messages')!.map(row => String(row.id))
    const groups = createSmartGroupsStore(mock.api, () => [{ id: 'forest', address: 'forest@example.test' }])
    await groups.ready
    await groups.update(() => normalizeSmartGroups({
      enabled: true,
      provider: { provider: 'jev', connectionId: 'jev', model: 'jev-1.13.0' },
      accounts: { forest: { groups: [{ id: 'family', name: 'Family', decision: 'Personal messages from family', threshold: 60, rules: [], children: [] }] } }
    }))
    const fakeVcf = {
      getSnapshot: () => ({ root: 'Contacts', contacts: [], count: 1, emailCount: 1, loading: false }),
      subscribe: () => () => {},
      ready: async () => {},
      resolveEmail: (addr: string) => addr === 'birk@fernwood.example' ? parseVcfFile('Contacts/Birk.vcf', 'BEGIN:VCARD\nVERSION:4.0\nFN:Birk Fernwood\nEMAIL:birk@fernwood.example\nCATEGORIES:Family\nEND:VCARD') : [],
      resolveEmails: () => new Map(),
      search: () => [],
      toDirectoryEntry: (c: { id: string; displayName: string; emails: { address: string; label?: string }[] }) => ({ id: c.id, displayName: c.displayName, emails: c.emails }),
      dispose: async () => {}
    }
    const seen: AiClassificationRequest[] = []
    mock.api.ai.classify = vi.fn(async (req: AiClassificationRequest): Promise<AiClassificationResult> => {
      seen.push(req)
      return { status: 'completed', categoryId: 'family', confidence: 0.94, probabilities: { family: 0.94, uncategorized: 0.06 }, model: 'jev-1.13.0' }
    })
    const queue = createClassificationQueue(mock.api, groups, () => {}, async () => {}, fakeVcf)
    disposers.push(() => groups.dispose(), queue.dispose)
    await queue.enqueue(ids)
    await vi.waitFor(async () => expect(await mock.api.data.dataset('classification_jobs').count({ status: 'completed' })).toBe(1))

    expect(seen).toHaveLength(1)
    expect(seen[0].provider).toBe('jev')
    const payload = JSON.parse(seen[0].input)
    expect(payload.senderContact).toEqual({ known: true, name: 'Birk Fernwood', groups: ['Family'] })
    expect(payload.signals).toEqual({ automatedSender: false, hasUnsubscribe: false })

    // Regrouping re-queues completed messages for the current revision and preserves manual assignments.
    const queued = await queue.enqueueAccount('forest', 'reclassify')
    expect(queued).toBe(1)
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    await queue.assign(ids[0], 'family', true)
    expect(await queue.enqueueAccount('forest', 'reclassify')).toBe(0)
  })
})

describe('Email icons, colours and smart group semantics', () => {
  it('seeds bundled icons into .valley/assets/icons/email-icon without overwriting user edits and sanitizes custom SVGs', async () => {
    const files = new Map<string, string>([['megaphone.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>']])
    const fakeStorage = {
      open: vi.fn(async () => ({ handle: 'h1', area: 'metadata' as const, path: 'assets/icons/email-icon', kind: 'directory' as const, mode: 'write' as const })),
      mkdir: vi.fn(async () => {}),
      list: vi.fn(async () => [...files.entries()].map(([name, content]) => ({ name, kind: 'file' as const, size: content.length }))),
      write: vi.fn(async (loc: { path: string }, content: string) => { files.set(loc.path, content) }),
      read: vi.fn(async (loc: { path: string }) => files.get(loc.path) ?? ''),
      close: vi.fn(async () => {})
    }
    const result = await readEmailIcons({ storage: fakeStorage as never })
    expect(Object.keys(result.icons).length).toBeGreaterThanOrEqual(Object.keys(DEFAULT_EMAIL_ICONS).length)
    // User's edited megaphone.svg was preserved, not overwritten.
    expect(result.icons.megaphone).toContain('<circle cx="12" cy="12" r="8"/>')
    expect(files.has('receipt.svg')).toBe(true)
    expect(files.has('plane.svg')).toBe(true)

    // SVG sanitization strips script elements and event handlers.
    const cleaned = sanitizeEmailSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onclick="alert(1)"><script>evil()</script><path d="M2 2h20"/></svg>')
    expect(cleaned).toContain('<path d="M2 2h20"/>')
    expect(cleaned).not.toContain('script')
    expect(cleaned).not.toContain('onclick')
  })

  it('keeps accountRevision stable across icon and colour changes and includes subgroup context in parent descriptions', async () => {
    const base: SmartGroup[] = [{
      id: 'marketing',
      name: 'Marketing & Promotions',
      decision: 'Sales and promotional offers',
      threshold: 60,
      icon: 'megaphone',
      color: 'palette:orange',
      rules: [],
      children: [{ id: 'coupons', name: 'Coupons', decision: 'Discount codes', threshold: 60, rules: [], children: [] }]
    }]
    const recolored: SmartGroup[] = [{ ...base[0], icon: 'percent', color: 'palette:pink' }]
    expect(await accountRevision(undefined, { groups: base })).toBe(await accountRevision(undefined, { groups: recolored }))
    expect(groupDisplayIcon({ id: 'promo', name: 'Marketing & Promotions' })).toBe('megaphone')
    expect(groupDisplayIcon({ id: 'receipts-transportation', name: 'Transportation' })).toBe('train')
    expect(groupDisplayIcon({ id: 'receipts-donations', name: 'Donations' })).toBe('heart')
    expect(groupDisplayIcon({ id: 'family-dinner', name: 'Dinner' })).toBe('utensils')
    expect(groupDisplayIcon({ id: 'family-invitations', name: 'Invitations and events' })).toBe('calendar')
    expect(groupDisplayIcon({ id: 'family-photos', name: 'Photos and other' })).toBe('image')
    expect(groupDisplayIcon({ id: 'ads-deals', name: 'Deals & Offers' })).toBe('percent')

    const seenDescriptions: string[] = []
    await decideSmartGroup(base, { sender: 'sale@shop.example', contactIds: new Set() }, async (categories) => {
      seenDescriptions.push(...categories.map((c) => c.description))
      return { status: 'completed', categoryId: 'uncategorized', confidence: 0.9, probabilities: Object.fromEntries(categories.map((c) => [c.id, c.id === 'uncategorized' ? 0.9 : 0.1])), model: 'jev' }
    })
    expect(seenDescriptions[0]).toContain('includes subgroups: Coupons')
  })
})
