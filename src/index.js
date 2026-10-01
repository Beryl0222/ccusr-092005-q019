export { EventStore } from "./core/eventStore.js";
export { canonicalize, sha256Hex, fingerprint } from "./core/hash.js";
export { DomainError, Errors } from "./core/errors.js";

export { Event, Stage, STAGE_ORDER, ConsentSection } from "./domain/events.js";
export {
  initialState,
  reducer,
  project,
  canonicalCandidateId,
  getCandidate,
  equivalenceGroup,
  identityGroupCandidateIds,
} from "./domain/projection.js";
export {
  hasConflict,
  accessFor,
  tallyCandidate,
  rankRound,
  allocateQuotas,
  buildPublicationContent,
} from "./domain/policy.js";

export { SelectionService } from "./services/selectionService.js";
export { ReviewService } from "./services/reviewService.js";
export { PublicityService } from "./services/publicityService.js";
export { AuditService } from "./services/auditService.js";

import { EventStore } from "./core/eventStore.js";
import { SelectionService } from "./services/selectionService.js";
import { ReviewService } from "./services/reviewService.js";
import { PublicityService } from "./services/publicityService.js";
import { AuditService } from "./services/auditService.js";

/** 组装一套共享同一事件存储的遴选后端服务。 */
export function createHonorsBackend({ clock } = {}) {
  const store = new EventStore(clock);
  return {
    store,
    selection: new SelectionService(store, clock),
    review: new ReviewService(store, clock),
    publicity: new PublicityService(store, clock),
    audit: new AuditService(store),
  };
}
