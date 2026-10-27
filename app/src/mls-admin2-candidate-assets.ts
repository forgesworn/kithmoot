import pin from './mls-admin2-candidate-pin.json'
export { pin as ADMIN2_CANDIDATE_PIN }
export async function verifyAdmin2CandidateFile(file: keyof typeof pin.files | 'manifest.json', bytes: ArrayBuffer): Promise<void> {
  const expected = file === 'manifest.json' ? pin.manifest : pin.files[file]
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
  if (hash !== expected) throw new Error(`Admin2 product candidate bytes differ: ${file}`)
}
