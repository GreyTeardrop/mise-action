import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as glob from '@actions/glob'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { miseDir } from './utils'

async function run(): Promise<void> {
  try {
    await setToolVersions()
    await setMiseToml()

    if (core.getBooleanInput('cache')) {
      await restoreMiseCache()
    } else {
      core.setOutput('cache-hit', false)
    }

    const version = core.getInput('version')
    await setupMise(version)
    setEnvVarsPreInstall()
    await testMise()
    if (core.getBooleanInput('install')) {
      await miseInstall()
    }
    await setEnvVars()
  } catch (err) {
    if (err instanceof Error) core.setFailed(err.message)
    else throw err
  }
}

function setEnvVarsPreInstall(): void {
  core.startGroup('Setting env vars for Mise')
  setEnvIfUnset('MISE_TRUSTED_CONFIG_PATHS', process.cwd())
  setEnvIfUnset('MISE_YES', '1')
  setEnvIfUnset('MISE_EXPERIMENTAL', getExperimental() ? '1' : '0')
}

async function setEnvVars(): Promise<void> {
  const envOutput = await miseEnv()

  core.startGroup('Setting env vars')
  if (envOutput.exitCode === 0) {
    const envVars: { [key: string]: string } = JSON.parse(envOutput.stdout)
    for (const [key, value] of Object.entries(envVars)) {
      if (key !== 'PATH') {
        setEnv(key, value)
      } else {
        for (const pathElement of value.split(path.delimiter)) {
          core.info(`Adding ${pathElement} to PATH`)
          core.addPath(pathElement)
        }
      }
    }
  } else {
    throw new Error(`Failed to run mise env: ${envOutput.stderr}`)
  }
}

async function restoreMiseCache(): Promise<void> {
  core.startGroup('Restoring mise cache')
  const cachePath = miseDir()
  const fileHash = await glob.hashFiles(
    [
      `**/.config/mise/config.toml`,
      `**/.mise.*.toml`,
      `**/.mise.toml`,
      `**/.mise/config.toml`,
      `**/.tool-versions`
    ].join('\n')
  )
  const prefix = core.getInput('cache_key_prefix') || 'mise-v0'
  const primaryKey = `${prefix}-${getOS()}-${os.arch()}-${fileHash}`

  core.saveState('CACHE', core.getBooleanInput('cache_save') ?? true)
  core.saveState('PRIMARY_KEY', primaryKey)
  core.saveState('MISE_DIR', cachePath)

  const cacheKey = await cache.restoreCache([cachePath], primaryKey)
  core.setOutput('cache-hit', Boolean(cacheKey))

  if (!cacheKey) {
    core.info(`mise cache not found for ${primaryKey}`)
    return
  }

  core.saveState('CACHE_KEY', cacheKey)
  core.info(`mise cache restored from key: ${cacheKey}`)
}

async function setupMise(version: string | undefined): Promise<void> {
  core.startGroup(version ? `Setup mise@${version}` : 'Setup mise')
  const miseBinDir = path.join(miseDir(), 'bin')
  const url = version
    ? `https://mise.jdx.dev/v${version}/mise-v${version}-${getOS()}-${os.arch()}`
    : `https://mise.jdx.dev/mise-latest-${getOS()}-${os.arch()}`
  await fs.promises.mkdir(miseBinDir, { recursive: true })
  await exec.exec('curl', [
    '-fsSL',
    url,
    '--output',
    path.join(miseBinDir, 'mise')
  ])
  await exec.exec('chmod', ['+x', path.join(miseBinDir, 'mise')])
  core.addPath(miseBinDir)
}

function getExperimental(): boolean {
  const experimentalString = core.getInput('experimental')
  return experimentalString === 'true' ? true : false
}

async function setToolVersions(): Promise<void> {
  const toolVersions = core.getInput('tool_versions')
  if (toolVersions) {
    await writeFile('.tool-versions', toolVersions)
  }
}

async function setMiseToml(): Promise<void> {
  const toml = core.getInput('mise_toml')
  if (toml) {
    await writeFile('.mise.toml', toml)
  }
}

function getOS(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macos'
    default:
      return process.platform
  }
}

const setEnvIfUnset = (k: string, v: string): void => {
  if (!process.env[k]) {
    setEnv(k, v)
  }
}
const setEnv = (k: string, v: string): void => {
  core.info(`Setting ${k}=${v}`)
  core.exportVariable(k, v)
}

const testMise = async (): Promise<exec.ExecOutput> => mise(['--version'])
const miseInstall = async (): Promise<exec.ExecOutput> => mise(['install'])
const miseEnv = async (): Promise<exec.ExecOutput> => mise(['env', '--json'])
const mise = async (args: string[]): Promise<exec.ExecOutput> =>
  core.group(`Running mise ${args.join(' ')}`, async () => {
    const cwd = core.getInput('install_dir') || process.cwd()
    return exec.getExecOutput('mise', args, { cwd })
  })

const writeFile = async (p: fs.PathLike, body: string): Promise<void> =>
  core.group(`Writing ${p}`, async () => {
    core.info(`Body:\n${body}`)
    await fs.promises.writeFile(p, body, { encoding: 'utf8' })
  })

run()
