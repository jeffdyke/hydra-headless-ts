#!/usr/bin/env node
/**
 * CLI tool for running Effect functions from authFlow
 *
 * Usage:
 *   npm run cli -- list-clients
 *   npm run cli -- get-client <client-id>
 *   npm run cli -- create-client <client-name>
 *   npm run cli -- new-client <client-name>
 */

import { Effect, Exit, Cause, Layer, Schema, Logger, pipe } from 'effect'
import { type OAuth2ApiService, OAuth2ApiServiceLive } from './api/oauth2.js'
import * as authFlow from './authFlow.js'
import { appConfig } from './config.js'
import { createLoggerLayer } from './fp/bootstrap.js'
import { HttpStatusError, NetworkError, type ParseError } from './fp/errors.js'


/**
 * Setup OAuth2 API Layer with configuration
 */
const setupLayer = () => {

  const oauth2Config = {
    basePath: appConfig.hydraInternalAdmin,
    headers: {
      'Content-Type': 'application/json',
    },
  }

  return Layer.merge(
    createLoggerLayer(),
    OAuth2ApiServiceLive(oauth2Config)
  )
}

/**
 * Run an Effect program with the configured runtime
 */
const runEffect = async <A, E>(
  program: Effect.Effect<A, E, OAuth2ApiService>
): Promise<Exit.Exit<A, E>> => {
  const layer = setupLayer()
  const runnable = Effect.provide(program, layer)
  return Effect.runPromiseExit(runnable)
}

interface FormattedHttpStatusError {
  type: 'HttpStatusError';
  status: number;
  statusText: string;
  body: unknown;
}

interface FormattedNetworkError {
  type: 'NetworkError';
  message: string;
  cause: unknown;
}

interface FormattedUnexpectedError {
  type: 'UnexpectedError';
  name: string;
  message: string;
  stack?: string;
}

interface GenericError {
  error: string;
}

interface GenericDefect {
  defect: string;
}

type FormattedError =
  | FormattedHttpStatusError
  | FormattedNetworkError
  | FormattedUnexpectedError
  | GenericError
  | GenericDefect;

/**
 * Pretty print an error cause
 */
const formatError = (cause: Cause.Cause<unknown>): string => {
  const failures = Cause.failures(cause)
  const defects = Cause.defects(cause)

  const formatFailure = (failure: unknown): FormattedError => {
    if (failure instanceof HttpStatusError) {
      return {
        type: 'HttpStatusError',
        status: failure.status,
        statusText: failure.statusText,
        body: failure.body,
      }
    }
    if (failure instanceof NetworkError) {
      return {
        type: 'NetworkError',
        message: failure.message,
        cause: failure.cause,
      }
    }
    if (typeof failure === 'object' && failure !== null) {
      return failure as FormattedError
    }
    return { error: String(failure) }
  }

  const formatDefect = (defect: unknown): FormattedError => {
    if (defect instanceof Error) {
      return {
        type: 'UnexpectedError',
        name: defect.name,
        message: defect.message,
        stack: defect.stack,
      }
    }
    return { defect: String(defect) }
  }

  const errors = [
    ...Array.from(failures).map(formatFailure),
    ...Array.from(defects).map(formatDefect)
  ]

  if (errors.length === 0) {
    return JSON.stringify({
      error: 'Unknown error',
      cause: Cause.pretty(cause)
    }, null, 2)
  }

  return errors.length === 1
    ? JSON.stringify(errors[0], null, 2)
    : JSON.stringify(errors, null, 2)
}

/**
 * Format and print result
 */
const printResult = (exit: Exit.Exit<unknown, unknown>) => {
  // console, not Effect.logInfo/logError. Those CONSTRUCT an Effect and return
  // it; as bare statements they were never run, so this function printed
  // nothing whatsoever. `ensure-client` therefore exited 1 in total silence,
  // which is worst of all in a container start-up pre-flight: the entrypoint
  // reports that the check failed but nothing says why, and the operator cannot
  // tell "client missing" from "admin API unreachable".
  //
  // The same construct-but-never-run pattern appears at other call sites in this
  // file (the usage/validation messages); they are equally silent.
  // Success goes to stdout so the payload can be piped or parsed; failures to
  // stderr. (The lint config permits only console.warn/error, and console.log
  // would be the wrong stream for a machine-readable result anyway.)
  if (Exit.isSuccess(exit)) {
    process.stdout.write(`\nSuccess!\n${JSON.stringify(exit.value, null, 2)}\n`)
  } else {
    console.error('\nError!')
    console.error(formatError(exit.cause))
    process.exit(1)
  }
}
const uuidRegexp = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i
/**
 * Command handlers
 */
type CommandHandler = (...args: string[]) => Promise<void>;
// A client-id is either a Hydra-issued DCR id (UUID) or a CIMD client_id,
// which is itself an https:// URL (see fp/services/cimd.ts).
const ClientIdV = pipe(
  Schema.NonEmptyString,
  Schema.filter((s) => uuidRegexp.test(s) || s.startsWith('https://'), {
    message: () => 'client-id must be a UUID (DCR) or an https:// URL (CIMD)',
  })
)

type ClientIdV = Schema.Schema.Type<typeof ClientIdV>
const parseClientId = (clientId:string): Effect.Effect<string, ParseError, never> => {
  return Schema.decode(ClientIdV)(clientId)
}

const commands: Record<string, CommandHandler> = {
  'list-clients': async () => {
    Effect.logInfo('Listing all OAuth2 clients...')
    const program = authFlow.listClients()
    const exit = await runEffect(program)
    printResult(exit)
  },

  'get-client': async (clientId: string) => {
    if (!clientId) {
      Effect.log('Error: client-id is required')
      Effect.log('Usage: cli get-client <client-id>')
      process.exit(1)
    }
    Effect.log(`Getting client: ${clientId}...`)
    const program = authFlow.getClient(clientId)
    const exit = await runEffect(program)
    printResult(exit)
  },

  'safe-get-client': async (clientId: string) => {

    const program = parseClientId(clientId).pipe(
      Effect.andThen((validated) => {
        Effect.logInfo(`Safely getting client: ${clientId}...`),
        Effect.map(() => authFlow.safeGetClient(validated))
      })
    ).pipe(Effect.provide(Logger.json))
    const exit = await runEffect(program)
    printResult(exit)
  },

  'create-client': async (clientId: string) => {
    if (!clientId) {
      Effect.logError('Error: client-id is required')
      Effect.logError('Usage: cli create-client <client-id>')
      process.exit(1)
    }
    Effect.logInfo(`Creating client with validation: ${clientId}...`)
    const program = authFlow.createClient(clientId)
    const exit = await runEffect(program)
    printResult(exit)
  },

  'new-client': async (clientName: string) => {
    if (!clientName) {
      Effect.logError('Error: client-name is required')
      Effect.logError('Usage: cli new-client <client-name>')
      process.exit(1)
    }
    Effect.logInfo(`Creating new client: ${clientName}...`)
    const program = authFlow.newClient(clientName)
    const exit = await runEffect(program)
    printResult(exit)
  },

  // Run this after any fresh install or suspected DB reset.
  // Exits non-zero and prints instructions if the configured client is missing.
  'ensure-client': async () => {
    Effect.logInfo('Verifying configured OAuth2 client exists in Hydra...')
    const program = authFlow.ensureClient()
    const exit = await runEffect(program)
    printResult(exit)
  },

  'help': async () => {
    Effect.logInfo(`
CLI for running Effect functions from authFlow

Usage: npm run cli -- <command> [arguments]

Commands:
  list-clients              List all OAuth2 clients
  get-client <client-id>    Get a specific client by ID
  safe-get-client <id>      Get a client with error handling
  create-client <id>        Create client with validation
  new-client <name>         Create a new OAuth2 client
  'help': async () => {
    const helpText = [
      'CLI for running Effect functions from authFlow',
      '',
      'Usage: npm run cli -- <command> [arguments]',
      '',
      'Commands:',
      '  list-clients              List all OAuth2 clients',
      '  get-client <client-id>    Get a specific client by ID',
      '  safe-get-client <id>      Get a client with error handling',
      '  create-client <id>        Create client with validation',
      '  new-client <n>            Create a new OAuth2 client',
      '  help                      Show this help message',
      '',
      'Examples:',
      '  npm run cli -- list-clients',
      '  npm run cli -- get-client abc123',
      '  npm run cli -- new-client "My Application"',
      '',
      'Environment:',
      '  Requires proper configuration in env files',
      '  - HYDRA_ADMIN_URL for Ory Hydra admin endpoint',
      '  - BASE_URL for application base URL',
    ].join('\n')
    Effect.logError(helpText)
`)
  }
}

/**
 * Main CLI entry point
 */
const main = async () => {
  const args = process.argv.slice(2)
  const command = args[0]
  const params = args.slice(1)

  if (!command || command === 'help') {
    await commands.help()
    return
  }

  const handler = commands[command as keyof typeof commands]

  if (!handler) {
    Effect.logError(`Unknown command: ${command}`)
    await commands.help()
    process.exit(1)
  }

  try {
    await handler(...params)
  } catch (error) {
    Effect.logError('Unexpected error:', error)
    process.exit(1)
  }
}

// Run the CLI
main().catch((error) => {
  Effect.logError('Fatal error:', error)
  process.exit(1)
})
