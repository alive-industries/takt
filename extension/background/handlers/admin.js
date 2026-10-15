import {
  createClient as createBackendClient,
  getBigQuerySyncStatus,
  getOrgConfig as getBackendOrgConfig,
  listClients as listBackendClients,
  listMembers as listBackendMembers,
  mapClientProject as mapBackendClientProject,
  mapProjectRepository as mapBackendProjectRepository,
  pushBigQuery,
  putOrgConfig as putBackendOrgConfig,
  upsertMember as upsertBackendMember,
} from '../takt-api.js';

export const adminHandlers = {
  GET_BIGQUERY_SYNC_STATUS: async () => {
    try {
      return { ok: true, status: await getBigQuerySyncStatus() };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  PUSH_BIGQUERY: async () => {
    try {
      return { ok: true, result: await pushBigQuery() };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  LIST_CLIENTS: async () => {
    try {
      return { ok: true, clients: await listBackendClients() };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  ADMIN_CREATE_CLIENT: async (payload) => {
    try {
      return { ok: true, client: await createBackendClient(payload) };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  ADMIN_MAP_CLIENT_PROJECT: async (payload) => {
    try {
      return {
        ok: true,
        client: await mapBackendClientProject(payload.clientId, payload.project),
      };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  ADMIN_MAP_PROJECT_REPO: async (payload) => {
    try {
      return {
        ok: true,
        client: await mapBackendProjectRepository(
          payload.clientId, payload.projectId, payload.repo
        ),
      };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  ADMIN_LIST_MEMBERS: async () => {
    try {
      const members = await listBackendMembers();
      return { ok: true, members };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  ADMIN_UPSERT_MEMBER: async (payload) => {
    try {
      const member = await upsertBackendMember(payload);
      return { ok: true, member };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  ADMIN_GET_ORG_CONFIG: async () => {
    try {
      const config = await getBackendOrgConfig();
      return { ok: true, config };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  ADMIN_PUT_ORG_CONFIG: async (payload) => {
    try {
      const config = await putBackendOrgConfig(payload);
      return { ok: true, config };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },
};
