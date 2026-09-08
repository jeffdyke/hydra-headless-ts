# Development Guide

Complete guide for developing, testing, and maintaining the hydra-headless-ts project.

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode (local environment)
npm run start:local

# Run tests
npm test

# Run linter
npm run lint

# Full validation (typecheck + lint + test)
npm run validate
```

## Project Structure

```text
hydra-headless-ts/
├── src/
│   ├── fp/                      # Functional programming modules
│   │   ├── config.ts            # Effect-based configuration
│   │   ├── domain.ts            # Effect Schema types
│   │   ├── bootstrap.ts         # Service layer composition
│   │   ├── services/            # Effect services
│   │   │   ├── redis.ts         # Redis service
│   │   │   ├── hydra.ts         # Hydra OAuth2 API service
│   │   │   ├── google.ts        # Google OAuth service
│   │   │   └── *.test.ts        # Service tests
│   │   └── errors.ts            # Custom error types
│   ├── routes/                  # Express route handlers
│   ├── api/                     # API clients
│   ├── env/                     # Environment configurations
│   │   ├── local.env
│   │   ├── staging.env
│   │   └── production.env
│   └── app-fp.ts                # Main application (FP version)
├── vitest.config.ts             # Test configuration
├── eslint.config.js             # Linting configuration
├── tsconfig.json                # TypeScript configuration
└── package.json                 # Dependencies and scripts
```

## Environment Configuration

The project uses environment-specific configuration files in `src/env/`:

### Local Development

```bash
npm run start:local   # Uses ./src/env/local.env
```

### Staging

```bash
npm run start:staging # Uses ./src/env/staging.env
```

### Production

```bash
npm run start:production # Uses ./src/env/production.env
```

See [src/env/local.env](src/env/local.env) and [src/env/staging.env](src/env/staging.env) for configuration examples.

## Development Workflow

### 1. Make Changes

Edit source files in `src/`. The project uses:

- **Effect** for functional programming
- **Effect Schema** for runtime validation
- **TypeScript** for type safety
- **Express** for HTTP server

### 2. Test Changes

```bash
# Run all tests
npm test

# Watch mode (re-runs on file changes)
npm run test:watch

# Coverage report
npm run test:coverage

# Interactive UI
npm run test:ui
```

### 3. Lint and Format

```bash
# Check formatting
npm run format:check

# Auto-format code
npm run format

# Run linter
npm run lint

# Auto-fix linting issues
npm run lint:fix
```

### 4. Type Check

```bash
# Check TypeScript types
npm run typecheck
```

### 5. Full Validation

```bash
# Run everything (typecheck + lint + test)
npm run validate
```

## Testing

Comprehensive test suite covering all Effect-based services:

- **Unit Tests**: Individual service functions
- **Integration Tests**: Service layer composition
- **Schema Tests**: Runtime validation with Effect Schema

**Test Files**:

- `src/fp/config.test.ts` - Configuration service
- `src/fp/domain.test.ts` - Schema validation
- `src/fp/services/redis.test.ts` - Redis operations
- `src/fp/services/hydra.test.ts` - Hydra OAuth2 API
- `src/fp/services/google.test.ts` - Google OAuth
- `src/fp/bootstrap.test.ts` - Layer composition

See [README.test.md](README.test.md) for detailed testing documentation.

## Linting

The project follows TypeScript and functional programming best practices:

- **ESLint 9** with flat config
- **TypeScript ESLint** for type-aware linting
- **Import order** enforcement
- **Functional programming** patterns

See [LINTING.md](LINTING.md) for detailed linting documentation.

## Building

```bash
# Clean build artifacts
npm run clean

# Build TypeScript
npm run build

# Watch mode (rebuild on changes)
npm run tswatch
```

Build outputs:

- `dist/` - Compiled JavaScript
- `lib/` - Package distribution

## Running the Application

### Development Mode

```bash
# Local environment with hot reload
npm run start:local

# Staging environment
npm run start:staging

# Production environment
npm run start:production
```

### Production Mode

```bash
# Build first
npm run build

# Serve built files
npm run serve:local      # Local
npm run serve:staging    # Staging
npm run serve:production # Production
```

> **Follow-up/cleanup TODO:** `serve:staging`/`serve:production` set
> `NODE_ENV='--env-file=/etc/hydra-headless-ts/hydra.env'` — that's a stray
> flag string assigned to the wrong variable, not a real mechanism for
> loading the file. It's currently harmless: `docker-compose.yml` already
> injects `hydra.env` via its own `env_file:` directive, so the container's
> process env is correct regardless. But it's confusing to read and worth
> removing in a small follow-up PR rather than leaving it to look load-bearing.

## Effect Patterns

The codebase uses Effect for functional programming:

### Services

```typescript
import { Effect, Layer, Context } from 'effect'

export interface MyService {
  readonly operation: (input: string) => Effect.Effect<Result, Error>
}

export const MyService = Context.GenericTag<MyService>('MyService')

export const MyServiceLive = Layer.succeed(
  MyService,
  makeMyService()
)
```

### Using Services

```typescript
const program = Effect.gen(function* () {
  const service = yield* MyService
  const result = yield* service.operation('input')
  return result
})

// Provide dependencies
const runnable = Effect.provide(program, MyServiceLive)

// Execute
const result = await Effect.runPromise(runnable)
```

### Error Handling

```typescript
const program = Effect.gen(function* () {
  const result = yield* riskyOperation
  return result
})

// Handle errors
const result = await Effect.runPromise(
  Effect.either(program)
)

if (result._tag === 'Left') {
  console.error('Error:', result.left)
} else {
  console.log('Success:', result.right)
}
```

## Common Tasks

### Add a New Service

1. Create service interface in `src/fp/services/myservice.ts`:

```typescript
export interface MyService {
  readonly operation: (input: string) => Effect.Effect<Result, Error>
}

export const MyService = Context.GenericTag<MyService>('MyService')
```

- Create service implementation:

  ```typescript
  export const makeMyService = (): MyService => ({
    operation: (input) => Effect.succeed(result)
  })

  export const MyServiceLive = Layer.succeed(MyService, makeMyService())
  ```

- Add to bootstrap in `src/fp/bootstrap.ts`:

```typescript
const myServiceLayer = MyServiceLive()
return Layer.mergeAll(existingLayers, myServiceLayer)
```

- Write tests in `src/fp/services/myservice.test.ts`

### Add a New Route

- Create route handler in `src/routes/myroute-fp.ts`
- Use services via Effect:

```typescript
const program = Effect.gen(function* () {
  const service = yield* MyService
  return yield* service.operation(input)
})

const result = await Effect.runPromise(
  Effect.provide(program, serviceLayer)
)
```

- Register route in `src/app-fp.ts`

### Add Environment Variable

- Add to `src/env/*.env` files:

```bash
MY_VARIABLE=value
```

- Add to config schema in `src/fp/config.ts`:

```typescript
const myVariableConfig = Config.string('MY_VARIABLE')
  .pipe(Config.withDefault('default-value'))
```

- Add to AppConfig interface:

```typescript
export interface AppConfig {
  readonly myVariable: string
  // ... other config
}
```

## Troubleshooting

### Tests Failing

```bash
# Clear test cache
rm -rf node_modules/.vitest

# Re-run tests
npm test
```

### TypeScript Errors

```bash
# Rebuild
npm run clean && npm run build

# Check types
npm run typecheck
```

### Linting Issues

```bash
# Auto-fix
npm run lint:fix

# Format code
npm run format
```

### Environment Issues

- Check `.env` files exist in `src/env/`
- Verify required variables are set
- Check APP_ENV matches environment file name

## Resources

- [Effect Documentation](https://effect.website/)
- [TypeScript Documentation](https://www.typescriptlang.org/)
- [ESLint Documentation](https://eslint.org/)
- [Vitest Documentation](https://vitest.dev/)
- [Express Documentation](https://expressjs.com/)

## Contributing

1. Create a feature branch
2. Make changes
3. Run `npm run validate` to ensure quality
4. Commit with descriptive message
5. Create pull request

### Git Workflow

```bash
# Create feature branch
git checkout -b feature/my-feature

# Make changes and test
npm run validate

# Commit
git add .
git commit -m "feat: add my feature"

# Push
git push origin feature/my-feature
```
