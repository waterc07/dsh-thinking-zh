/**
 * Install `dsh-thinking-zh` into a DSH profile.
 *
 * Idempotent: re-running only repairs what is missing. Writes a timestamped
 * backup of `package.json` before the first change and creates the
 * `node_modules/<name>` junction that pnpm would normally own, so a profile
 * whose lockfile is never regenerated still resolves the plugin.
 *
 *   node scripts/install.mjs [--profile desktop] [--dry-run] [--uninstall]
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-thinking-zh'
const pluginDirectory = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const profileName = option('profile', 'desktop')
const dryRun = flag('dry-run')
const uninstall = flag('uninstall')
const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const profileDirectory = join(home, 'profiles', profileName)
const manifestPath = join(profileDirectory, 'package.json')
const junctionPath = join(profileDirectory, 'node_modules', PACKAGE_NAME)

if (!existsSync(manifestPath)) {
  console.error(`dsh-thinking-zh: no profile manifest at ${manifestPath}`)
  process.exit(1)
}

// pnpm records a portable `link:` specifier relative to the profile, the same
// shape the plugin manager writes for every other out-of-tree plugin. Fall back
// to an absolute specifier when the two directories live on different drives.
const relativeSpec = relative(profileDirectory, resolve(pluginDirectory)).replace(/\\/g, '/')
const dependencySpec = relativeSpec !== '' && !relativeSpec.includes(':')
  ? `link:${relativeSpec}`
  : `link:${resolve(pluginDirectory).replace(/\\/g, '/')}`

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

const changes = []

if (uninstall) {
  if (manifest.dependencies[PACKAGE_NAME] !== undefined) {
    delete manifest.dependencies[PACKAGE_NAME]
    changes.push('remove dependency')
  }
  const before = manifest.dsh.profile.bundles.length
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((bundle) => bundle !== PACKAGE_NAME)
  if (manifest.dsh.profile.bundles.length !== before) changes.push('remove bundle')
} else {
  if (manifest.dependencies[PACKAGE_NAME] !== dependencySpec) {
    manifest.dependencies[PACKAGE_NAME] = dependencySpec
    changes.push(`dependency -> ${dependencySpec}`)
  }
  if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles.push(PACKAGE_NAME)
    changes.push('append bundle (highest priority layer)')
  }
}

const needJunction = !uninstall && !existsSync(junctionPath)
const needManifest = changes.length > 0

if (dryRun) {
  console.log(`profile: ${profileDirectory}`)
  console.log(changes.length === 0 ? 'manifest: already installed' : `manifest: ${changes.join(', ')}`)
  console.log(needJunction ? `junction: would create ${junctionPath}` : 'junction: present')
  process.exit(0)
}

if (needManifest) {
  const backup = `${manifestPath}.bak-${PACKAGE_NAME}-${String(Date.now())}`
  await copyFile(manifestPath, backup)
  await writeFile(manifestPath, `${JSON.stringify(manifest, void 0, 2)}\n`, 'utf8')
  console.log(`manifest: ${changes.join(', ')} (backup ${backup})`)
} else {
  console.log('manifest: already installed')
}

if (needJunction) {
  await mkdir(dirname(junctionPath), { recursive: true })
  execFileSync('cmd', ['/c', 'mklink', '/J', junctionPath, pluginDirectory], { stdio: 'inherit' })
  console.log(`junction: ${junctionPath} -> ${pluginDirectory}`)
} else if (!uninstall) {
  console.log('junction: present')
}

if (uninstall && existsSync(junctionPath)) {
  execFileSync('cmd', ['/c', 'rmdir', junctionPath], { stdio: 'inherit' })
  console.log(`junction: removed ${junctionPath}`)
}

console.log('')
console.log('重启 DSH 后生效（档案变更在启动时读取）。')


