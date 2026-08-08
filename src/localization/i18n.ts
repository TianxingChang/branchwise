import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  fallbackLng: "en",
  resources: {
    en: {
      translation: {
        appName: "branchwise",
        documentation: "Documentation",
        madeBy: "Built on electron-shadcn",
        titleHomePage: "Home Page",
        titleSecondPage: "Second Page",
      },
    },
    "pt-BR": {
      translation: {
        appName: "branchwise",
        documentation: "Documentação",
        madeBy: "Feito com electron-shadcn",
        titleHomePage: "Página Inicial",
        titleSecondPage: "Segunda Página",
      },
    },
  },
});
