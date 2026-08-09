import {
  attach,
  getAgentConfig,
  history,
  interrupt,
  respondPermissionRoute,
  sendMessage,
  setAgentConfig,
} from "./handlers";

export const agent = {
  attach,
  getConfig: getAgentConfig,
  history,
  interrupt,
  respondPermission: respondPermissionRoute,
  send: sendMessage,
  setConfig: setAgentConfig,
};
