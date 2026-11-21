// 工具层装配（T4）：把 T1 领域模块 / T2 项目模块注入工具 spec，并注册到 ctx.tools。
import * as storeApi from '../store.js'
import * as docsApi from '../docs.js'
import * as leasesApi from '../leases.js'
import * as exporterApi from '../export.js'
import * as importerApi from '../import.js'
import * as projectApi from '../project.js'
import * as projectDefaults from '../project-defaults.js'
import * as indexerApi from '../indexer.js'
import * as checkersApi from '../checkers.js'
import * as scopeApi from '../scope.js'
import { registerToolDefinitions, createToolSpecs, toolCatalog } from './register.js'

/** 组装工具依赖（测试可传入替身）。 */
export function createToolDeps(ctx, registry, bus) {
  return {
    ctx: ctx,
    registry: registry,
    bus: bus,
    store: storeApi,
    docs: docsApi,
    leases: leasesApi,
    exporter: exporterApi,
    importer: importerApi,
    project: projectApi,
    projectDefaults: projectDefaults,
    indexer: indexerApi,
    checkers: checkersApi,
    scope: scopeApi,
  }
}

/** 插件入口（index.js 调用）：注册全部项目工具。 */
export function registerTools(ctx, registry, bus) {
  return registerToolDefinitions(ctx, createToolDeps(ctx, registry, bus))
}

export { createToolSpecs, toolCatalog, registerToolDefinitions }
