/** Stable PostgreSQL advisory namespaces; changing a value would split an existing authority gate. */
export const LOCK_NAMESPACE = Object.freeze({
  ownerAuthentication: 1745083477,
  requestThrottle: 1745083476,
  modelConnections: 1297040460,
  browser: 1326850642,
  workerIdentity: 1326850643,
  nodeEnrollment: 1326831444,
  botCreation: 1869636212,
  automations: 1330660686,
  taskSource: 731,
  portability: 0,
});
