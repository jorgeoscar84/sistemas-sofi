/**
 * Driver simulado del SRI para desarrollo y pruebas (modo `mock`).
 * No requiere certificado ni internet: autoriza localmente cualquier comprobante
 * cuyo XML incluya una clave de acceso válida.
 */

export interface MockSriClient {
  sendRecepcion(xmlSigned: string): {
    estado: 'RECIBIDA' | 'DEVUELTA';
    comprobantes: { claveAcceso: string; estado: string; mensajes: { identificador?: string; mensaje?: string; tipo?: string }[] }[];
  };
  consultarAutorizacion(claveAcceso: string): {
    estado: 'AUTORIZADO' | 'NO AUTORIZADO' | 'PENDIENTE';
    numeroAutorizacion?: string;
    fechaAutorizacion?: string;
    comprobanteXml?: string;
    mensajes: { identificador?: string; mensaje?: string; tipo?: string }[];
  };
}

export interface MockOptions {
  /** Simula rechazo del SRI para probar el flujo de estados `failed`. */
  reject?: boolean;
  /** Simula SRI no disponible para probar el modo `offline`. */
  offline?: boolean;
}

export function createMockSriClient(options: MockOptions = {}): MockSriClient {
  const autorizaciones = new Map<string, { numero: string; fecha: string; xml?: string }>();

  return {
    sendRecepcion(xmlSigned) {
      const clave = /<claveAcceso>(\d{49})<\/claveAcceso>/.exec(xmlSigned)?.[1] ?? '';
      if (options.offline) {
        throw new Error('Servicio de recepción del SRI no disponible (simulado)');
      }
      if (options.reject) {
        return {
          estado: 'DEVUELTA',
          comprobantes: [
            {
              claveAcceso: clave,
              estado: 'DEVUELTA',
              mensajes: [
                {
                  identificador: '39',
                  mensaje: 'FIRMA INVÁLIDA (simulado)',
                  tipo: 'ERROR',
                },
              ],
            },
          ],
        };
      }
      return {
        estado: 'RECIBIDA',
        comprobantes: [{ claveAcceso: clave, estado: 'RECIBIDA', mensajes: [] }],
      };
    },

    consultarAutorizacion(claveAcceso) {
      if (options.offline) {
        throw new Error('Servicio de autorización del SRI no disponible (simulado)');
      }
      if (options.reject) {
        return {
          estado: 'NO AUTORIZADO',
          mensajes: [{ identificador: '39', mensaje: 'FIRMA INVÁLIDA (simulado)', tipo: 'ERROR' }],
        };
      }
      let auth = autorizaciones.get(claveAcceso);
      if (!auth) {
        auth = {
          numero: claveAcceso.slice(0, 40),
          fecha: new Date().toISOString(),
        };
        autorizaciones.set(claveAcceso, auth);
      }
      return {
        estado: 'AUTORIZADO',
        numeroAutorizacion: auth.numero,
        fechaAutorizacion: auth.fecha,
        mensajes: [],
      };
    },
  };
}
