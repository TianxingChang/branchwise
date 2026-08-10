import {
  attach,
  getAgentConfig,
  history,
  interrupt,
  prepareInheritanceRoute,
  respondPermissionRoute,
  sendMessage,
  setAgentConfig,
} from "./handlers";

export const agent = {
  attach,
  getConfig: getAgentConfig,
  history,
  interrupt,
  prepareInheritance: prepareInheritanceRoute,
  respondPermission: respondPermissionRoute,
  send: sendMessage,
  setConfig: setAgentConfig,
};
