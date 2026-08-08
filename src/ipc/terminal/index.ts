import {
  attach,
  killTerminal,
  killUnderPath,
  resizeTerminal,
  restartTerminal,
  write,
} from "./handlers";

export const terminal = {
  attach,
  kill: killTerminal,
  killUnder: killUnderPath,
  resize: resizeTerminal,
  restart: restartTerminal,
  write,
};
