import { ReferenceData } from '../../domain/model';

// Las tools no entregan país. Tabla mínima (supuesto) para la condición "international" (R2).
// En producción vendría de un maestro de aeropuertos. Aeropuerto desconocido => el hecho queda indeterminado.
export const REFERENCE_DATA: ReferenceData = {
  airportCountry: {
    SCL: 'CL', LIM: 'PE', MEX: 'MX', EZE: 'AR', GRU: 'BR', BOG: 'CO', MAD: 'ES', MIA: 'US', JFK: 'US',
  },
};
