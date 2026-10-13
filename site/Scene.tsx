import { useEffect, useRef, useState } from "react";
import { useSiteLanguage } from "./i18n";
import type { ManorController, SceneFeature, SceneOptions } from "./scene/controller";

interface ManorSceneProps extends SceneOptions {
  language: "zh-CN" | "en";
  onFeature(feature: SceneFeature): void;
  onReady(): void;
  onError(): void;
}

export function ManorScene(props: ManorSceneProps) {
  const { t } = useSiteLanguage();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<ManorController | null>(null);
  const current = useRef(props);
  current.current = props;
  const [hover, setHover] = useState<SceneFeature | null>(null);

  useEffect(() => {
    let disposed = false;
    void import("./scene/controller").then(({ createManorController }) => {
      if (disposed || !canvas.current || !host.current) return;
      controller.current = createManorController(canvas.current, host.current, {
        onFeature: feature => current.current.onFeature(feature),
        onHover: setHover,
        onError: () => current.current.onError(),
      });
      controller.current.setOptions(current.current);
      current.current.onReady();
    }).catch(() => { if (!disposed) current.current.onError(); });
    return () => { disposed = true; controller.current?.dispose(); controller.current = null; };
  }, []);

  useEffect(() => {
    controller.current?.setOptions(props);
  }, [props.installationOpen, props.paused, props.view, props.resetKey]);

  return <div ref={host} className="manor-renderer">
    <canvas ref={canvas} tabIndex={0} role="img" aria-label={t("site.scene.canvas")} />
    {hover && <span className="scene-hotspot" aria-hidden="true">{t(`site.product.${hover}.name`)}</span>}
  </div>;
}
