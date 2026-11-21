import type { ParticipantView } from "@portal/api";
import L from "leaflet";
import type { LayerGroup, LatLngTuple, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { classifyParticipant } from "../lib/geo";

/**
 * The map is deliberately a lazy chunk (ActiveShareScreen imports it with
 * React.lazy): a location app needs a map, but nobody pays for Leaflet, the
 * raster tiles or the tile network until they open it.
 *
 * Tiles come from a configurable provider. The public OSM tile server is for
 * prototyping only — its usage policy is not a production plan — so the URLs
 * are build-time environment variables (see .env.example), and the list view
 * remains the accessible, always-available representation.
 */
const TILE_URL =
  (import.meta.env.VITE_MAP_TILES_URL as string | undefined) ??
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const TILE_ATTRIBUTION =
  (import.meta.env.VITE_MAP_TILES_ATTRIBUTION as string | undefined) ??
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export default function ShareMap({
  participants,
  serverTime,
}: {
  participants: ParticipantView[];
  serverTime: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const markers = useRef<LayerGroup | null>(null);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, {
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
    });
    L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: TILE_ATTRIBUTION,
    }).addTo(instance);
    instance.setView([20, 0], 2);
    markers.current = L.layerGroup().addTo(instance);
    map.current = instance;
    // The container is styled by CSS and the map mounts after a tab switch, so
    // give the browser one frame before measuring it.
    requestAnimationFrame(() => instance.invalidateSize());

    return () => {
      instance.remove();
      map.current = null;
      markers.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    const group = markers.current;
    if (!instance || !group) return;

    group.clearLayers();
    const located = participants.filter(
      (participant) => participant.lat !== null && participant.lng !== null,
    );

    for (const participant of located) {
      const state = classifyParticipant(participant, serverTime).state;
      const icon = L.divIcon({
        className: `share-pin share-pin--${state}${participant.isYou ? " is-you" : ""}`,
        html: `<span class="share-pin-dot"></span><span class="share-pin-label">${escapeHtml(
          participant.displayName,
        )}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      const position: LatLngTuple = [participant.lat!, participant.lng!];
      const marker = L.marker(position, { icon, keyboard: true, title: participant.displayName });
      marker.addTo(group);

      if (participant.accuracy !== null && participant.accuracy > 0) {
        L.circle(position, {
          radius: Math.min(participant.accuracy, 5_000),
          className: "share-accuracy",
          interactive: false,
        }).addTo(group);
      }
    }

    if (located.length > 0) {
      const bounds = L.latLngBounds(
        located.map((participant) => [participant.lat!, participant.lng!] as LatLngTuple),
      );
      instance.fitBounds(bounds.pad(0.25), { maxZoom: 16, animate: false });
    }
  }, [participants, serverTime]);

  return (
    <div
      className="share-map"
      ref={container}
      role="region"
      aria-label="Map of everyone in this share"
    />
  );
}
