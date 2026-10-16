/** Persistent Electron browser-session selection for enterprise employee storage. */

import { join } from 'node:path'
import type { EnterpriseDataSpace } from './enterprise-data-space.ts'

/** Session creation and protocol registration owned by the native desktop shell. */
export interface EnterpriseBrowserSessionsOptions<Session extends object> {
  /** Create or reopen a persistent session at the supplied absolute directory. */
  factory(path: string): Session
  /** Configure this session before use; failures must leave registrations safe to retry. */
  configure(session: Session): void
}

/** Reuses each employee's configured browser session without changing the default session. */
export class EnterpriseBrowserSessions<Session extends object> {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly options: EnterpriseBrowserSessionsOptions<Session>) {}

  /**
   * Open an employee or bootstrap browser session and configure it once before returning it.
   * Failed creation or configuration is not cached; the caller owns reporting and retry.
   * @param space Validated storage roots selected for this desktop identity.
   * @returns The configured session persisted below this data space's home directory.
   */
  forSpace(space: EnterpriseDataSpace): Session {
    const path = join(space.home, 'browser-session')
    const existing = this.sessions.get(path)
    if (existing !== undefined) return existing
    const session = this.options.factory(path)
    this.options.configure(session)
    this.sessions.set(path, session)
    return session
  }
}
