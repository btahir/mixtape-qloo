"use client";
import { useState } from "react";
import Image from "next/image";
import type { Entity } from "@/lib/domain";
import { PrintCover } from "./print";

export function EntityArt({ entity, index }: { entity: Entity; index: number }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return <div className={`entity-art-wrap media-${entity.kind}${entity.imageUrl && !failed ? " with-art" : ""}`} data-art-state={!entity.imageUrl || failed ? "fallback" : loaded ? "loaded" : "loading"}>
    <PrintCover kind={entity.kind} title={entity.name} index={index} />
    {entity.imageUrl && !failed && <figure className={`entity-art art-${entity.kind}${loaded ? "" : " art-pending"}`}>
      <div className="entity-image"><Image src={entity.imageUrl} alt="" fill unoptimized loading={index === 0 ? "eager" : "lazy"} referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} /></div>
      {entity.imageAttribution && <figcaption>{entity.imageAttribution}</figcaption>}
    </figure>}
  </div>;
}
