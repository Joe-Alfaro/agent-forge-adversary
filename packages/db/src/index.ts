export interface DbConfig {
  connectionString: string
}

export function resolveDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const connectionString = env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set')
  }
  return { connectionString }
}
