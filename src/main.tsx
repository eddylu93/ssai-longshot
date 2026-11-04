import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CaptureOverlay from "./CaptureOverlay";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has("capture")
      ? <CaptureOverlay controls={new URLSearchParams(window.location.search).get("capture") === "controls"} />
      : <App />}
  </React.StrictMode>
);

