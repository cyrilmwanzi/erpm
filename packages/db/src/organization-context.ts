import { AsyncLocalStorage } from "node:async_hooks";

const organizationStorage = new AsyncLocalStorage<string>();

export const OrganizationContext = {
  run<T>(organizationId: string, fn: () => T): T {
    if (!organizationId || typeof organizationId !== "string") {
      throw new Error(
        "A valid organizationId is required to enter OrganizationContext.",
      );
    }
    return organizationStorage.run(organizationId, fn);
  },

  getOrganizationId(): string | undefined {
    return organizationStorage.getStore();
  },

  requireOrganizationId(): string {
    const organizationId = organizationStorage.getStore();
    if (!organizationId) {
      throw new Error(
        "OrganizationContext missing: protected organization query executed outside an active organization scope.",
      );
    }
    return organizationId;
  },
};
