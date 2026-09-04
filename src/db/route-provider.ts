import { noopLogger, type Logger, type RouteConfig, type RouteProvider } from '@endclose/relay'
import { runSqlite, type Db } from '@endclose/relay-sqlite'
import { RoutesRepo } from './repo/routes.js'

/** Live route definitions from the appliance database: every config apply is visible immediately. */
export class DbRouteProvider implements RouteProvider {
  private routes: RoutesRepo
  private logger: Logger
  constructor(db: Db, logger: Logger = noopLogger) {
    this.routes = new RoutesRepo(db)
    this.logger = logger
  }
  get(id: string): Promise<RouteConfig | undefined> {
    return runSqlite('routes.get', () => this.routes.get(id), { logger: this.logger })
  }
  all(): Promise<RouteConfig[]> {
    return runSqlite('routes.all', () => this.routes.all(), { logger: this.logger })
  }
}
