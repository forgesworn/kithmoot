// Picks the installer for this computer and lets anyone choose another
// version. Everything is worked out in the browser; nothing about the visitor
// is sent anywhere. Without this script the page still lists every platform.

const PLATFORMS = [
  { id: 'mac', label: 'Mac (Apple Silicon)', product: 'desktop', match: file => file.os === 'mac' },
  { id: 'windows', label: 'Windows x64', product: 'desktop', match: file => file.os === 'windows' },
  { id: 'deb', label: 'Linux: Debian, Ubuntu, Mint, Pop!_OS (.deb)', product: 'desktop', match: file => file.kind === 'deb' },
  { id: 'tarball', label: 'Linux: any distribution (.tar.gz)', product: 'desktop', match: file => file.kind === 'tarball' },
  { id: 'android', label: 'Android', product: 'android', match: () => true },
]
const ARCH_NAME = { x64: 'x64 (Intel or AMD)', arm64: 'ARM64', any: '' }

const mebibytes = bytes => `${Math.round(bytes / 1048576)} MiB`
const longDate = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

function element(tag, properties = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'text') node.textContent = value
    else if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child)
  return node
}

async function system() {
  const agent = navigator.userAgent
  let platform = ''
  let arch = ''
  let hinted = false
  try {
    const hints = await navigator.userAgentData?.getHighEntropyValues?.(['platform', 'architecture', 'bitness'])
    if (hints) {
      platform = hints.platform ?? ''
      arch = hints.architecture === 'arm' ? 'arm64' : hints.architecture === 'x86' ? 'x64' : ''
      hinted = Boolean(arch)
    }
  } catch {}
  let os
  if (/Android/i.test(platform) || /Android/i.test(agent)) os = 'android'
  else if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) os = 'ios'
  else if (/Chrome OS|ChromeOS/i.test(platform) || /CrOS/.test(agent)) os = 'chromeos'
  else if (/Windows/i.test(platform) || /Windows/.test(agent)) os = 'windows'
  else if (/macOS/i.test(platform) || /Macintosh|Mac OS X/.test(agent)) os = 'mac'
  else if (/Linux/i.test(platform) || /Linux|X11/.test(agent)) os = 'linux'
  if (!arch) {
    if (/aarch64|arm64|armv8/i.test(agent)) arch = 'arm64'
    else if (/x86_64|x64|Win64|WOW64|amd64/i.test(agent)) arch = 'x64'
  }
  // Safari and Firefox on a Mac always claim Intel; the graphics chip does not.
  if (os === 'mac' && !hinted) {
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      const info = gl?.getExtension('WEBGL_debug_renderer_info')
      const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : ''
      arch = /Apple (M\d|GPU)/.test(renderer) ? 'arm64' : /Intel|AMD|Radeon/i.test(renderer) ? 'x64' : ''
    } catch { arch = '' }
  }
  const family = /Fedora|Red Hat|SUSE|Arch Linux|Manjaro/.test(agent) ? 'other' : /Ubuntu|Debian|Mint|Pop!?_OS|elementary|Zorin/i.test(agent) ? 'debian' : ''
  return { os, arch, family }
}

/** The newest release that has a file for this platform, and its files for it. */
function latest(manifest, platform) {
  for (const release of manifest[platform.product]) {
    const files = release.files.filter(platform.match)
    if (files.length) return { release, files }
  }
}

function downloadButton(file, label, primary) {
  return element('a', { class: primary ? 'button primary' : 'button', href: file.url, download: '', text: label })
}

function recommend(manifest, { os, arch, family }) {
  const card = document.getElementById('recommended')
  const body = card.querySelector('.recommended-body')
  const title = card.querySelector('h2')
  const say = text => body.append(element('p', { text }))
  const under = (file, version) => body.append(element('p', { class: 'under', text: `Version ${version} · ${mebibytes(file.bytes)} · SHA-256 ${file.sha256.slice(0, 16)}…` }))
  const other = (text, href) => body.append(element('a', { class: 'source-link', href, text }))
  const pick = id => latest(manifest, PLATFORMS.find(platform => platform.id === id))

  if (os === 'mac') {
    const found = pick('mac')
    if (arch === 'x64') {
      title.textContent = 'Your Mac has an Intel processor'
      say('There is no Intel Mac build yet. KithMoot works fully in your browser, with nothing to install.')
      body.append(element('a', { class: 'button primary', href: '/j/', text: 'Open in browser' }))
    } else {
      title.textContent = 'KithMoot for your Mac'
      say('Signed and notarised by Apple, and it keeps itself up to date.')
      body.append(downloadButton(found.files[0], 'Download for Mac', true)); under(found.files[0], found.release.version)
      if (!arch) say('For Apple Silicon Macs (M1 and later). On an Intel Mac, use KithMoot in your browser.')
    }
  } else if (os === 'windows') {
    const found = pick('windows')
    title.textContent = 'KithMoot for Windows'
    say(arch === 'arm64' ? 'This x64 build runs on Windows on ARM through Windows’ own emulation.' : 'A portable app: extract the ZIP and open KithMoot.exe.')
    body.append(downloadButton(found.files[0], 'Download for Windows', true)); under(found.files[0], found.release.version)
  } else if (os === 'linux') {
    const debs = pick('deb')
    const tarballs = pick('tarball')
    const choose = found => found && (found.files.filter(file => !arch || file.arch === arch))
    title.textContent = arch ? `KithMoot for Linux ${ARCH_NAME[arch]}` : 'KithMoot for Linux'
    if (debs && family !== 'other') {
      say('For Debian, Ubuntu, Mint, Pop!_OS and other Debian-based systems. Open the package with your software installer, or run sudo apt install on it. Updates then arrive with your system updates, and your profile is kept.')
      for (const file of choose(debs)) { body.append(downloadButton(file, arch ? 'Download .deb package' : `Download .deb for ${ARCH_NAME[file.arch]}`, true)); under(file, debs.release.version) }
      if (tarballs) for (const file of choose(tarballs)) other(`Another distribution? ${file.filename}`, file.url)
    } else if (tarballs) {
      say('Extract the archive and run python3 install.py inside it. It installs for your user only, without sudo.')
      for (const file of choose(tarballs)) { body.append(downloadButton(file, arch ? 'Download .tar.gz' : `Download .tar.gz for ${ARCH_NAME[file.arch]}`, true)); under(file, tarballs.release.version) }
      if (debs) other('Debian or Ubuntu? Get the .deb package instead', '#linux')
    }
    if (!arch) say('Not sure which? Run uname -m: x86_64 means x64, aarch64 means ARM64.')
  } else if (os === 'android') {
    const found = pick('android')
    const file = found.files.find(candidate => candidate.kind === 'production') ?? found.files[0]
    title.textContent = 'KithMoot for Android'
    say('For Android 13 and later. Open the download and choose Install, or Update over an earlier version.')
    body.append(downloadButton(file, `Download Android ${found.release.version}`, true)); under(file, found.release.version)
  } else if (os === 'ios' || os === 'chromeos') {
    title.textContent = os === 'ios' ? 'KithMoot on your iPhone or iPad' : 'KithMoot on your Chromebook'
    say('Use KithMoot in your browser and add it to your home screen. There is nothing to install.')
    body.append(element('a', { class: 'button primary', href: '/j/', text: 'Open in browser' }))
  } else return
  other('Not your computer? See every download', '#downloads')
  card.hidden = false
}

function picker(manifest) {
  const form = document.getElementById('versionPicker')
  const platformSelect = document.getElementById('pickPlatform')
  const versionSelect = document.getElementById('pickVersion')
  const list = document.getElementById('pickFiles')
  for (const platform of PLATFORMS) {
    if (manifest[platform.product].some(release => release.files.some(platform.match))) platformSelect.append(element('option', { value: platform.id, text: platform.label }))
  }
  const platform = () => PLATFORMS.find(candidate => candidate.id === platformSelect.value)
  const releases = () => manifest[platform().product].filter(release => release.files.some(platform().match))
  const fillVersions = () => {
    versionSelect.replaceChildren(...releases().map((release, index) =>
      element('option', { value: release.version, text: `${release.version}${index === 0 ? ' (latest)' : ''} · ${longDate(release.published)}` })))
    show()
  }
  const show = () => {
    const release = releases().find(candidate => candidate.version === versionSelect.value)
    list.replaceChildren(...release.files.filter(platform().match).map(file => element('li', {}, [
      element('a', { href: file.url, download: '', text: file.filename }),
      element('span', { class: 'under', text: ` ${ARCH_NAME[file.arch] ? `${ARCH_NAME[file.arch]} · ` : ''}${mebibytes(file.bytes)}` }),
      element('code', { class: 'checksum', text: file.sha256 }),
    ])))
  }
  platformSelect.addEventListener('change', fillVersions)
  versionSelect.addEventListener('change', show)
  const initial = location.hash.match(/^#versions-(\w+)$/)?.[1]
  if (initial && PLATFORMS.some(candidate => candidate.id === initial)) platformSelect.value = initial
  fillVersions()
  form.hidden = false
}

async function start() {
  let manifest
  try {
    const response = await fetch('versions.json', { cache: 'no-cache' })
    if (!response.ok) return
    manifest = await response.json()
  } catch { return }
  picker(manifest)
  recommend(manifest, await system())
}

start()
