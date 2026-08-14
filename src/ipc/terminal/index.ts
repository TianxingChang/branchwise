import {
  attach,
  killTerminal,
  killUnderPath,
  listTerminals,
  resizeTerminal,
  restartTerminal,
  write,
} from "./handlers";

export const terminal = {
  attach,
  kill: killTerminal,
  killUnder: killUnderPath,
  list: listTerminals,
  resize: resizeTerminal,
  restart: restartTerminal,
  write,
};
