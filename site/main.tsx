import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/noto-serif-sc";
import "./style.css";
import { App } from "./App";
import { SiteLanguageProvider } from "./i18n";

createRoot(document.getElementById("root")!).render(
  <StrictMode><SiteLanguageProvider><App /></SiteLanguageProvider></StrictMode>,
);
