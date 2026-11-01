import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installScripting } from "./lib/scripting";
import "./styles.css";
import { APP_NAME } from "./config/brand";

installScripting();
document.title = APP_NAME;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
