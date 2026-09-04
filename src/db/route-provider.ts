import type { RouteConfig, RouteProvider } from '@endclose/relay'
import type { Db } from '@endclose/relay-sqlite'
import { RoutesRepo } from './repo/routes.js'

/** Live route definitions from the appliance database: every config apply is visible immediately. */
export class DbRouteProvider implements RouteProvider {
  private routes: RoutesRepo
  constructor(db: Db) {
    this.routes = new RoutesRepo(db)
  }
  async get(id: string): Promise<RouteConfig | undefined> {
    return this.routes.get(id)
  }
  async all(): Promise<RouteConfig[]> {
    return this.routes.all()
  }
}
