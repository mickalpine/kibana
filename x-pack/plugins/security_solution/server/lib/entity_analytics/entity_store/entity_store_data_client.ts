/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  Logger,
  ElasticsearchClient,
  SavedObjectsClientContract,
  AuditLogger,
  IScopedClusterClient,
  AnalyticsServiceSetup,
} from '@kbn/core/server';
import { EntityClient } from '@kbn/entityManager-plugin/server/lib/entity_client';
import type { SortOrder } from '@elastic/elasticsearch/lib/api/types';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import type { DataViewsService } from '@kbn/data-views-plugin/common';
import { isEqual } from 'lodash/fp';
import moment from 'moment';
import type { AppClient } from '../../..';
import type {
  Entity,
  EngineDataviewUpdateResult,
  InitEntityEngineRequestBody,
  InitEntityEngineResponse,
  EntityType,
  InspectQuery,
} from '../../../../common/api/entity_analytics';
import { EngineDescriptorClient } from './saved_object/engine_descriptor';
import { ENGINE_STATUS, MAX_SEARCH_RESPONSE_SIZE } from './constants';
import { AssetCriticalityEcsMigrationClient } from '../asset_criticality/asset_criticality_migration_client';
import { getUnitedEntityDefinition } from './united_entity_definitions';
import {
  startEntityStoreFieldRetentionEnrichTask,
  removeEntityStoreFieldRetentionEnrichTask,
} from './task';
import {
  createEntityIndex,
  deleteEntityIndex,
  createPlatformPipeline,
  deletePlatformPipeline,
  createEntityIndexComponentTemplate,
  deleteEntityIndexComponentTemplate,
  createFieldRetentionEnrichPolicy,
  executeFieldRetentionEnrichPolicy,
  deleteFieldRetentionEnrichPolicy,
} from './elasticsearch_assets';
import { RiskScoreDataClient } from '../risk_score/risk_score_data_client';
import {
  buildEntityDefinitionId,
  buildIndexPatterns,
  getEntitiesIndexName,
  isPromiseFulfilled,
  isPromiseRejected,
} from './utils';
import {
  ENTITY_ENGINE_INITIALIZATION_EVENT,
  ENTITY_ENGINE_RESOURCE_INIT_FAILURE_EVENT,
} from '../../telemetry/event_based/events';
import type { EntityRecord } from './types';
import { CRITICALITY_VALUES } from '../asset_criticality/constants';

interface EntityStoreClientOpts {
  logger: Logger;
  clusterClient: IScopedClusterClient;
  namespace: string;
  soClient: SavedObjectsClientContract;
  taskManager?: TaskManagerStartContract;
  auditLogger?: AuditLogger;
  kibanaVersion: string;
  dataViewsService: DataViewsService;
  appClient: AppClient;
  telemetry?: AnalyticsServiceSetup;
}

interface SearchEntitiesParams {
  entityTypes: EntityType[];
  filterQuery?: string;
  page: number;
  perPage: number;
  sortField: string;
  sortOrder: SortOrder;
}

export class EntityStoreDataClient {
  private engineClient: EngineDescriptorClient;
  private assetCriticalityMigrationClient: AssetCriticalityEcsMigrationClient;
  private entityClient: EntityClient;
  private riskScoreDataClient: RiskScoreDataClient;
  private esClient: ElasticsearchClient;

  constructor(private readonly options: EntityStoreClientOpts) {
    const { clusterClient, logger, soClient, auditLogger, kibanaVersion, namespace } = options;
    this.esClient = clusterClient.asCurrentUser;

    this.entityClient = new EntityClient({
      clusterClient,
      soClient,
      logger,
    });

    this.engineClient = new EngineDescriptorClient({
      soClient,
      namespace,
    });

    this.assetCriticalityMigrationClient = new AssetCriticalityEcsMigrationClient({
      esClient: this.esClient,
      logger,
      auditLogger,
    });

    this.riskScoreDataClient = new RiskScoreDataClient({
      soClient,
      esClient: this.esClient,
      logger,
      namespace,
      kibanaVersion,
    });
  }

  public async init(
    entityType: EntityType,
    { indexPattern = '', filter = '', fieldHistoryLength = 10 }: InitEntityEngineRequestBody,
    { pipelineDebugMode = false }: { pipelineDebugMode?: boolean } = {}
  ): Promise<InitEntityEngineResponse> {
    if (!this.options.taskManager) {
      throw new Error('Task Manager is not available');
    }

    const { logger } = this.options;

    await this.riskScoreDataClient.createRiskScoreLatestIndex();

    const requiresMigration =
      await this.assetCriticalityMigrationClient.isEcsDataMigrationRequired();

    if (requiresMigration) {
      throw new Error(
        'Asset criticality data migration is required before initializing entity store. If this error persists, please restart Kibana.'
      );
    }
    logger.info(
      `In namespace ${this.options.namespace}: Initializing entity store for ${entityType}`
    );

    const descriptor = await this.engineClient.init(entityType, {
      filter,
      fieldHistoryLength,
      indexPattern,
    });
    logger.debug(`Initialized engine for ${entityType}`);
    // first create the entity definition without starting it
    // so that the index template is created which we can add a component template to

    this.asyncSetup(
      entityType,
      fieldHistoryLength,
      this.options.taskManager,
      indexPattern,
      filter,
      pipelineDebugMode
    ).catch((error) => {
      logger.error(`There was an error during async setup of the Entity Store: ${error}`);
    });

    return descriptor;
  }

  private async asyncSetup(
    entityType: EntityType,
    fieldHistoryLength: number,
    taskManager: TaskManagerStartContract,
    indexPattern: string,
    filter: string,
    pipelineDebugMode: boolean
  ) {
    const setupStartTime = moment().utc().toISOString();
    const { logger, namespace, appClient, dataViewsService } = this.options;
    const indexPatterns = await buildIndexPatterns(namespace, appClient, dataViewsService);

    const unitedDefinition = getUnitedEntityDefinition({
      indexPatterns,
      entityType,
      namespace,
      fieldHistoryLength,
    });
    const { entityManagerDefinition } = unitedDefinition;

    const debugLog = (message: string) =>
      logger.debug(`[Entity Engine] [${entityType}] ${message}`);

    try {
      // clean up any existing entity store
      await this.delete(entityType, taskManager, { deleteData: false, deleteEngine: false });

      // set up the entity manager definition
      await this.entityClient.createEntityDefinition({
        definition: {
          ...entityManagerDefinition,
          filter,
          indexPatterns: indexPattern
            ? [...entityManagerDefinition.indexPatterns, ...indexPattern.split(',')]
            : entityManagerDefinition.indexPatterns,
        },
        installOnly: true,
      });
      debugLog(`Created entity definition`);

      // the index must be in place with the correct mapping before the enrich policy is created
      // this is because the enrich policy will fail if the index does not exist with the correct fields
      await createEntityIndexComponentTemplate({
        unitedDefinition,
        esClient: this.esClient,
      });
      debugLog(`Created entity index component template`);
      await createEntityIndex({
        entityType,
        esClient: this.esClient,
        namespace,
        logger,
      });
      debugLog(`Created entity index`);

      // we must create and execute the enrich policy before the pipeline is created
      // this is because the pipeline will fail if the enrich index does not exist
      await createFieldRetentionEnrichPolicy({
        unitedDefinition,
        esClient: this.esClient,
      });
      debugLog(`Created field retention enrich policy`);
      await executeFieldRetentionEnrichPolicy({
        unitedDefinition,
        esClient: this.esClient,
        logger,
      });
      debugLog(`Executed field retention enrich policy`);
      await createPlatformPipeline({
        debugMode: pipelineDebugMode,
        unitedDefinition,
        logger,
        esClient: this.esClient,
      });
      debugLog(`Created @platform pipeline`);

      // finally start the entity definition now that everything is in place
      const updated = await this.start(entityType, { force: true });
      debugLog(`Started entity definition`);

      // the task will execute the enrich policy on a schedule
      await startEntityStoreFieldRetentionEnrichTask({
        namespace,
        logger,
        taskManager,
      });
      logger.info(`Entity store initialized for ${entityType}`);

      const setupEndTime = moment().utc().toISOString();
      const duration = moment(setupEndTime).diff(moment(setupStartTime), 'seconds');
      this.options.telemetry?.reportEvent(ENTITY_ENGINE_INITIALIZATION_EVENT.eventType, {
        duration,
      });

      return updated;
    } catch (err) {
      this.options.logger.error(
        `Error initializing entity store for ${entityType}: ${err.message}`
      );

      this.options.telemetry?.reportEvent(ENTITY_ENGINE_RESOURCE_INIT_FAILURE_EVENT.eventType, {
        error: err.message,
      });

      await this.engineClient.update(entityType, ENGINE_STATUS.ERROR);

      await this.delete(entityType, taskManager, { deleteData: true, deleteEngine: false });
    }
  }

  public async getExistingEntityDefinition(entityType: EntityType) {
    const entityDefinitionId = buildEntityDefinitionId(entityType, this.options.namespace);

    const {
      definitions: [definition],
    } = await this.entityClient.getEntityDefinitions({
      id: entityDefinitionId,
    });

    if (!definition) {
      throw new Error(`Unable to find entity definition for ${entityType}`);
    }

    return definition;
  }

  public async start(entityType: EntityType, options?: { force: boolean }) {
    const descriptor = await this.engineClient.get(entityType);
    if (!options?.force && descriptor.status !== ENGINE_STATUS.STOPPED) {
      throw new Error(
        `In namespace ${this.options.namespace}: Cannot start Entity engine for ${entityType} when current status is: ${descriptor.status}`
      );
    }

    this.options.logger.info(
      `In namespace ${this.options.namespace}: Starting entity store for ${entityType}`
    );

    // startEntityDefinition requires more fields than the engine descriptor
    // provides so we need to fetch the full entity definition
    const fullEntityDefinition = await this.getExistingEntityDefinition(entityType);
    await this.entityClient.startEntityDefinition(fullEntityDefinition);

    return this.engineClient.update(entityType, ENGINE_STATUS.STARTED);
  }

  public async stop(entityType: EntityType) {
    const descriptor = await this.engineClient.get(entityType);

    if (descriptor.status !== ENGINE_STATUS.STARTED) {
      throw new Error(
        `In namespace ${this.options.namespace}: Cannot stop Entity engine for ${entityType} when current status is: ${descriptor.status}`
      );
    }

    this.options.logger.info(
      `In namespace ${this.options.namespace}: Stopping entity store for ${entityType}`
    );
    // stopEntityDefinition requires more fields than the engine descriptor
    // provides so we need to fetch the full entity definition
    const fullEntityDefinition = await this.getExistingEntityDefinition(entityType);
    await this.entityClient.stopEntityDefinition(fullEntityDefinition);

    return this.engineClient.update(entityType, ENGINE_STATUS.STOPPED);
  }

  public async get(entityType: EntityType) {
    return this.engineClient.get(entityType);
  }

  public async list() {
    return this.engineClient.list();
  }

  public async delete(
    entityType: EntityType,
    taskManager: TaskManagerStartContract,
    options = { deleteData: false, deleteEngine: true }
  ) {
    const { namespace, logger, appClient, dataViewsService } = this.options;
    const { deleteData, deleteEngine } = options;

    const descriptor = await this.engineClient.maybeGet(entityType);
    const indexPatterns = await buildIndexPatterns(namespace, appClient, dataViewsService);
    const unitedDefinition = getUnitedEntityDefinition({
      indexPatterns,
      entityType,
      namespace: this.options.namespace,
      fieldHistoryLength: descriptor?.fieldHistoryLength ?? 10,
    });
    const { entityManagerDefinition } = unitedDefinition;
    logger.info(`In namespace ${namespace}: Deleting entity store for ${entityType}`);
    try {
      try {
        await this.entityClient.deleteEntityDefinition({
          id: entityManagerDefinition.id,
          deleteData,
        });
      } catch (e) {
        logger.error(`Error deleting entity definition for ${entityType}: ${e.message}`);
      }
      await deleteEntityIndexComponentTemplate({
        unitedDefinition,
        esClient: this.esClient,
      });
      await deletePlatformPipeline({
        unitedDefinition,
        logger,
        esClient: this.esClient,
      });
      await deleteFieldRetentionEnrichPolicy({
        unitedDefinition,
        esClient: this.esClient,
        logger,
      });

      if (deleteData) {
        await deleteEntityIndex({
          entityType,
          esClient: this.esClient,
          namespace,
          logger,
        });
      }

      if (descriptor && deleteEngine) {
        await this.engineClient.delete(entityType);
      }
      // if the last engine then stop the task
      const { engines } = await this.engineClient.list();
      if (engines.length === 0) {
        await removeEntityStoreFieldRetentionEnrichTask({
          namespace,
          logger,
          taskManager,
        });
      }

      return { deleted: true };
    } catch (e) {
      logger.error(`Error deleting entity store for ${entityType}: ${e.message}`);
      // TODO: should we set the engine status to error here?
      throw e;
    }
  }

  public async searchEntities(params: SearchEntitiesParams): Promise<{
    records: Entity[];
    total: number;
    inspect: InspectQuery;
  }> {
    const { page, perPage, sortField, sortOrder, filterQuery, entityTypes } = params;

    const index = entityTypes.map((type) => getEntitiesIndexName(type, this.options.namespace));
    const from = (page - 1) * perPage;
    const sort = sortField ? [{ [sortField]: sortOrder }] : undefined;
    const query = filterQuery ? JSON.parse(filterQuery) : undefined;

    const response = await this.esClient.search<EntityRecord>({
      index,
      query,
      size: Math.min(perPage, MAX_SEARCH_RESPONSE_SIZE),
      from,
      sort,
      ignore_unavailable: true,
    });
    const { hits } = response;

    const total = typeof hits.total === 'number' ? hits.total : hits.total?.value ?? 0;

    const records = hits.hits.map((hit) => {
      const { asset, ...source } = hit._source as EntityRecord;

      const assetOverwrite: Pick<Entity, 'asset'> =
        asset && asset.criticality !== CRITICALITY_VALUES.DELETED
          ? { asset: { criticality: asset.criticality } }
          : {};

      return {
        ...source,
        ...assetOverwrite,
      };
    });

    const inspect: InspectQuery = {
      dsl: [JSON.stringify({ index, body: query }, null, 2)],
      response: [JSON.stringify(response, null, 2)],
    };

    return { records, total, inspect };
  }

  public async applyDataViewIndices(): Promise<{
    successes: EngineDataviewUpdateResult[];
    errors: Error[];
  }> {
    const { logger } = this.options;
    logger.info(
      `In namespace ${this.options.namespace}: Applying data view indices to the entity store`
    );

    const { engines } = await this.engineClient.list();

    const updateDefinitionPromises: Array<Promise<EngineDataviewUpdateResult>> = await engines.map(
      async (engine) => {
        const originalStatus = engine.status;
        const id = buildEntityDefinitionId(engine.type, this.options.namespace);
        const definition = await this.getExistingEntityDefinition(engine.type);

        if (
          originalStatus === ENGINE_STATUS.INSTALLING ||
          originalStatus === ENGINE_STATUS.UPDATING
        ) {
          throw new Error(
            `Error updating entity store: There are changes already in progress for engine ${id}`
          );
        }

        const indexPatterns = await buildIndexPatterns(
          this.options.namespace,
          this.options.appClient,
          this.options.dataViewsService
        );

        // Skip update if index patterns are the same
        if (isEqual(definition.indexPatterns, indexPatterns)) {
          return { type: engine.type, changes: {} };
        }

        // Update savedObject status
        await this.engineClient.update(engine.type, ENGINE_STATUS.UPDATING);

        try {
          // Update entity manager definition
          await this.entityClient.updateEntityDefinition({
            id,
            definitionUpdate: {
              ...definition,
              indexPatterns,
            },
          });

          // Restore the savedObject status and set the new index pattern
          await this.engineClient.update(engine.type, originalStatus);

          return { type: engine.type, changes: { indexPatterns } };
        } catch (error) {
          // Rollback the engine initial status when the update fails
          await this.engineClient.update(engine.type, originalStatus);

          throw error;
        }
      }
    );

    const updatedDefinitions = await Promise.allSettled(updateDefinitionPromises);

    const updateErrors = updatedDefinitions
      .filter(isPromiseRejected)
      .map((result) => result.reason);

    const updateSuccesses = updatedDefinitions
      .filter(isPromiseFulfilled<EngineDataviewUpdateResult>)
      .map((result) => result.value);

    return {
      successes: updateSuccesses,
      errors: updateErrors,
    };
  }
}
