// Full-image capture, dispatch and private key binding share the access closure.
export {
  captureOrdinaryHistoricalSnapshotContext,
  captureOrdinaryProjectedSnapshotContext,
  captureOrdinarySnapshotContext,
  releaseOrdinarySnapshotContext,
  validateOrdinarySnapshot,
  type OrdinarySnapshotContext,
  type OrdinarySnapshotCounts,
} from './ordinary-room-access-snapshot.js'
