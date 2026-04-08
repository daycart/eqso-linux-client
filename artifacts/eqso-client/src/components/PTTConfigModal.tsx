/**
 * PTTConfigModal — "Ajuste del radioenlace" dialog
 *
 * Replicates the PTT configuration panel from eQSO Windows:
 *   - Método de control: Puerto COM | VOX
 *   - Ajustar Puerto COM: selector de puerto + pin RTS/DTR + invertir voltaje
 */

import { useState } from "react";
import { usePTTSerial, type PTTConfig } from "@/hooks/usePTTSerial";

interface Props {
  onClose: () => void;
}

export function PTTConfigModal({ onClose }: Props) {
  const {
    config,
    setConfig,
    isSupported,
    portOpen,
    portError,
    requestPort,
    closePort,
  } = usePTTSerial();

  const [local, setLocal] = useState<PTTConfig>({ ...config });

  const handleSave = () => {
    setConfig(local);
    onClose();
  };

  const handleSelectPort = async () => {
    const ok = await requestPort();
    if (ok) {
      setLocal((c) => ({ ...c, portLabel: "Puerto abierto" }));
    }
  };

  const handleClosePort = async () => {
    await closePort();
    setLocal((c) => ({ ...c, portLabel: "" }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-[480px] max-w-[95vw]">

        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-800 rounded-t-lg">
          <span className="font-semibold text-gray-100 text-sm">Ajuste del radioenlace</span>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-5">

          {/* Método de control */}
          <fieldset className="border border-gray-700 rounded p-4">
            <legend className="text-xs text-gray-400 px-1">Método de control del equipo</legend>
            <div className="space-y-2 mt-1">
              {(["VOX", "COM"] as const).map((m) => (
                <label key={m} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value={m}
                    checked={local.method === m}
                    onChange={() => setLocal((c) => ({ ...c, method: m }))}
                    className="accent-green-500"
                  />
                  <span className="text-sm text-gray-200">
                    {m === "VOX"
                      ? "VOX (activación por voz)"
                      : "Puerto COM (control por puerto serie)"}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* COM port settings — only shown when method = COM */}
          {local.method === "COM" && (
            <fieldset className="border border-gray-700 rounded p-4">
              <legend className="text-xs text-gray-400 px-1">Ajustar Puerto COM</legend>

              {!isSupported && (
                <p className="text-xs text-yellow-400 mb-3">
                  Web Serial API no disponible. Usa Chrome o Edge en Linux.
                </p>
              )}

              {portError && (
                <p className="text-xs text-red-400 mb-3">{portError}</p>
              )}

              {/* Port open/close */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1">
                  <span className={`text-xs font-mono ${portOpen ? "text-green-400" : "text-gray-500"}`}>
                    {portOpen
                      ? "Puerto abierto"
                      : local.portLabel || "Sin puerto seleccionado"}
                  </span>
                </div>
                {!portOpen ? (
                  <button
                    onClick={handleSelectPort}
                    disabled={!isSupported}
                    className="text-xs px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 disabled:text-gray-500 rounded transition-colors text-white"
                  >
                    Seleccionar puerto...
                  </button>
                ) : (
                  <button
                    onClick={handleClosePort}
                    className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors text-gray-200"
                  >
                    Cerrar puerto
                  </button>
                )}
              </div>

              {/* Pin selection */}
              <div className="space-y-2">
                <p className="text-xs text-gray-400 mb-1">Pin de control PTT:</p>
                {(["RTS", "DTR"] as const).map((pin) => (
                  <label key={pin} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="pin"
                      value={pin}
                      checked={local.pin === pin}
                      onChange={() => setLocal((c) => ({ ...c, pin }))}
                      className="accent-green-500"
                    />
                    <span className="text-sm text-gray-200">{pin}</span>
                  </label>
                ))}
              </div>

              {/* Invertir voltaje */}
              <label className="flex items-center gap-2 cursor-pointer mt-4">
                <input
                  type="checkbox"
                  checked={local.invertVoltage}
                  onChange={(e) => setLocal((c) => ({ ...c, invertVoltage: e.target.checked }))}
                  className="accent-green-500 w-4 h-4"
                />
                <span className="text-sm text-gray-200">Invertir voltaje</span>
              </label>
            </fieldset>
          )}

          {/* VOX info */}
          {local.method === "VOX" && (
            <div className="bg-gray-800 border border-gray-700 rounded p-3">
              <p className="text-xs text-gray-400">
                En modo VOX el PTT se activa automaticamente cuando hay audio en el microfono.
                No se utiliza ningun puerto serie.
              </p>
            </div>
          )}

          {/* Current config summary */}
          <div className="bg-gray-800 border border-gray-700 rounded p-3">
            <p className="text-xs text-gray-500 font-mono">
              Configuracion activa:{" "}
              {config.method === "VOX"
                ? "VOX"
                : `COM — Pin ${config.pin}${config.invertVoltage ? " (invertido)" : ""}`}
            </p>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            className="px-5 py-2 text-sm bg-green-700 hover:bg-green-600 text-white rounded transition-colors font-medium"
          >
            Aceptar
          </button>
        </div>
      </div>
    </div>
  );
}
