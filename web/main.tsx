import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "./shared/styles/base.css";
import { App } from "./app/App";
import { I18nProvider } from "./shared/i18n";
import "./shared/styles/motion.css";

createRoot(document.getElementById("root")!).render(<StrictMode><I18nProvider><App /></I18nProvider></StrictMode>);
