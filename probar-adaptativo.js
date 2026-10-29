'use strict'

/**
 * Pruebas locales del motor adaptativo, con datos SINTETICOS.
 * No toca la red ni el API de EMIOS: valida la matematica, el parseo y los textos
 * antes de publicar la pieza.
 *
 *   node probar-adaptativo.js
 */

const motor = require('./src/lib/adaptativo')

let fallos = 0
function comprueba(descripcion, condicion, detalle) {
    const marca = condicion ? 'OK  ' : 'FALLO'
    if (!condicion) {
        fallos++
    }
    console.log(`${marca} ${descripcion}${detalle !== undefined && !condicion ? '  -> ' + JSON.stringify(detalle) : ''}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. Fechas y numeros ===')

comprueba('parsea el formato de EMIOS', JSON.stringify(motor.parseaFechaEmios('03-06-2024_14:00:00')) === JSON.stringify({ y: 2024, mo: 6, d: 3, h: 14, mi: 0, s: 0 }), motor.parseaFechaEmios('03-06-2024_14:00:00'))
comprueba('parsea el formato ISO', motor.parseaFechaEmios('2024-06-03 14:00:00')?.h === 14)
comprueba('rechaza texto basura', motor.parseaFechaEmios('hola') === null)
comprueba('mar 03-06-2024 es lunes (1)', motor.diaDeLaSemana({ y: 2024, mo: 6, d: 4 }) === 2, motor.diaDeLaSemana({ y: 2024, mo: 6, d: 4 }))
comprueba('numero "17.56"', motor.numero('17.56') === 17.56)
comprueba('numero "1.234,56"', motor.numero('1.234,56') === 1234.56)
comprueba('numero "" es null', motor.numero('') === null)
comprueba('numero "-" es null', motor.numero('-') === null)

const ventanas = motor.parteEnVentanas({ y: 2026, mo: 1, d: 1 }, motor.finDelDia({ y: 2026, mo: 3, d: 31 }))
comprueba('90 dias -> 3 ventanas (31/31/28)', ventanas.length === 3, ventanas)
comprueba('primera ventana de 31 dias', ventanas[0].desde === '01-01-2026_00:00:00' && ventanas[0].hasta === '31-01-2026_23:59:59', ventanas[0])
comprueba('ultima ventana termina el 31-03', ventanas[2].hasta === '31-03-2026_23:59:59', ventanas[2])
comprueba('mes de febrero 2024 tiene 29 dias', motor.diasDelMes({ y: 2024, mo: 2, d: 10 }) === 29)

// ---------------------------------------------------------------------------
console.log('\n=== 2. Parseo de la respuesta de EMIOS ===')

const respuestaEmios = {
    resultado: 'OK',
    valores_rango_fechas_sensor: {
        campos: ['incremento', 'consumo', 'coste'],
        numero_tuplas_valores: 3,
        tuplas_horas_valores: [
            { hora: '04-06-2024_13:00:00', tupla_valores: ['0.10', '1.20', '0.18'] },
            { hora: '04-06-2024_14:00:00', tupla_valores: ['0.40', '4.80', '0.72'] },
            { hora: '04-06-2024_15:00:00', tupla_valores: ['', '', ''] },
        ],
    },
}
const extraido = motor.extraePuntos(respuestaEmios, 'consumo')
comprueba('extrae 2 puntos validos y descarta el vacio', extraido.puntos.length === 2 && extraido.descartados === 1, extraido)
comprueba('usa la metrica pedida (consumo)', extraido.puntos[0].valor === 1.2 && extraido.puntos[1].valor === 4.8)
comprueba('recoge el coste de la misma tupla', extraido.puntos[1].coste === 0.72)
comprueba('detecta el dia de la semana', extraido.puntos[0].dia === 2 && extraido.puntos[0].hora === 13, extraido.puntos[0])

// ---------------------------------------------------------------------------
console.log('\n=== 3. Aprendizaje del perfil ===')

/** Genera 30 dias de lecturas horarias: patron por hora y por tipo de dia, con ruido fijo. */
function generaHistorico({ dias = 30, hoy = { y: 2026, mo: 10, d: 10 } }) {
    const puntos = []
    for (let desplazamiento = dias; desplazamiento >= 1; desplazamiento--) {
        const fecha = motor.sumaDias({ ...hoy, h: 0, mi: 0, s: 0 }, -desplazamiento)
        const dia = motor.diaDeLaSemana(fecha)
        const factorDia = (dia === 0 || dia === 6) ? 0.6 : 1
        for (let hora = 0; hora < 24; hora++) {
            const baseHora = (hora >= 8 && hora <= 20) ? 1.5 : 0.5
            const pico = (hora === 14) ? 2.2 : 1
            const ruido = ((hora * 7 + desplazamiento * 13) % 5) / 100   // 0..0.04, determinista
            const valor = Number(((baseHora * pico * factorDia) + ruido).toFixed(3))
            puntos.push({
                fecha, dia, hora, valor,
                coste: Number((valor * 0.15).toFixed(4)),
                ms: motor.sumaDias({ ...fecha, h: hora }, 0).y * 0 + 0,
            })
        }
    }
    return puntos
}

const historico = generaHistorico({ dias: 30 })
const modelo = motor.aprendeModelo(historico, 'consumo')

comprueba('modelo con 30 dias y 720 lecturas', modelo.dias === 30 && modelo.lecturas === 720, { dias: modelo.dias, lecturas: modelo.lecturas })
comprueba('el modelo tiene las 168 franjas de la semana', Object.keys(modelo.franjas).length === 168, Object.keys(modelo.franjas).length)
comprueba('la franja de las 14:00 tiene una media alta', modelo.franjas['2-14'].media > 2, modelo.franjas['2-14'])
comprueba('la franja de las 03:00 tiene una media baja', modelo.franjas['2-3'].media < 1, modelo.franjas['2-3'])
comprueba('los sabados consumen menos que un martes', modelo.franjas['6-14'].media < modelo.franjas['2-14'].media, { sabado: modelo.franjas['6-14'].media, martes: modelo.franjas['2-14'].media })
comprueba('el coste diario medio es coherente', modelo.coste.medio_dia > 0 && modelo.coste.medio_mes > modelo.coste.medio_dia, modelo.coste)

console.log('\n--- texto del perfil ---')
console.log(motor.resumenPerfil(modelo, { idRed: '2', idSensor: '51', nombreSensor: 'Cuadro principal' }))

// ---------------------------------------------------------------------------
console.log('\n=== 4. Deteccion de anomalias ===')

const hoy = { y: 2026, mo: 10, d: 10 }
const diaHoy = motor.sumaDias({ ...hoy, h: 0, mi: 0, s: 0 }, 0)
const dia = motor.diaDeLaSemana(diaHoy)
const normales = []
const factorFinDeSemana = (dia === 0 || dia === 6) ? 0.6 : 1
for (let hora = 0; hora < 24; hora++) {
    const baseHora = (hora >= 8 && hora <= 20) ? 1.5 : 0.5
    const pico = (hora === 14) ? 2.2 : 1
    // mismo patron que el historico (incluido el factor de fin de semana), sin ruido
    normales.push({ fecha: diaHoy, dia, hora, valor: baseHora * pico * factorFinDeSemana, coste: baseHora * pico * factorFinDeSemana * 0.15 })
}
// anomalia: a las 14:00 el valor se dispara (averia o riego fuera de hora)
const conAnomalia = normales.map((punto) => punto.hora === 14 ? { ...punto, valor: punto.valor * 3.5, coste: punto.valor * 3.5 * 0.15 } : punto)

const evaluacionNormal = motor.evaluaAnomalias({ puntos: normales, modelo, umbralSigma: 3, minimoMuestras: 5 })
comprueba('un dia normal no genera alarmas', evaluacionNormal.anomalias.length === 0, evaluacionNormal.anomalias.slice(0, 2))

const evaluacion = motor.evaluaAnomalias({ puntos: conAnomalia, modelo, umbralSigma: 3, minimoMuestras: 3 })
comprueba('detecta exactamente 1 anomalia', evaluacion.anomalias.length === 1, evaluacion.anomalias)
comprueba('la anomalia es la de las 14:00', evaluacion.anomalias[0]?.hora === 14, evaluacion.anomalias[0])
comprueba('marca gravedad alta', evaluacion.anomalias[0]?.gravedad === 'alta', evaluacion.anomalias[0])
comprueba('calcula el z-score', evaluacion.anomalias[0]?.z > 3, evaluacion.anomalias[0]?.z)
comprueba('indica que comparo contra su franja', evaluacion.anomalias[0]?.referencia === 'franja', evaluacion.anomalias[0]?.referencia)

// Con 30 dias cada franja tiene ~4 muestras: si se exige mas, debe usar el perfil por hora
const evaluacionPorHora = motor.evaluaAnomalias({ puntos: conAnomalia, modelo, umbralSigma: 3, minimoMuestras: 6 })
comprueba('si la franja no tiene muestras suficientes usa el perfil por hora', evaluacionPorHora.anomalias[0]?.referencia === 'hora', evaluacionPorHora.anomalias[0])
comprueba('y sigue detectando la anomalia', evaluacionPorHora.anomalias.length >= 1, evaluacionPorHora.anomalias.length)

// Falso positivo: un dia normal con un 5% mas no debe generar aviso
const casiIgual = normales.map((punto) => ({ ...punto, valor: punto.valor * 1.05 }))
const evaluacionCasi = motor.evaluaAnomalias({ puntos: casiIgual, modelo, umbralSigma: 3, minimoMuestras: 3 })
comprueba('una desviacion del 5% no dispara alarma', evaluacionCasi.anomalias.length === 0, evaluacionCasi.anomalias.slice(0, 2))

const gasto = motor.evaluaGasto({
    puntos: conAnomalia,
    modelo,
    costeMesAcumulado: 120,
    ahora: { ...hoy, h: 13 },
    presupuestoMes: 300,
})

comprueba('calcula el gasto del dia', gasto.coste_hoy > 0, gasto)
comprueba('calcula la desviacion del gasto del dia', gasto.desviacion_porcentaje !== null, gasto.desviacion_porcentaje)
const gastoAlto = motor.evaluaGasto({ puntos: conAnomalia.map((punto) => ({ ...punto, coste: punto.coste * 2 })), modelo, costeMesAcumulado: 120, ahora: { ...hoy, h: 13 }, presupuestoMes: 300 })
comprueba('detecta un dia con el doble de gasto', gastoAlto.desviacion_porcentaje > 50, gastoAlto.desviacion_porcentaje)
comprueba('proyecta el mes (120 EUR el dia 10 de 31)', Math.abs(gasto.proyeccion_mes - 372) < 1, gasto.proyeccion_mes)
comprueba('detecta que supera el presupuesto de 300', gasto.presupuesto.supera_presupuesto === true && gasto.presupuesto.exceso_previsto > 60, gasto.presupuesto)

console.log('\n--- texto de la alarma ---')
console.log('ASUNTO:', motor.asuntoAlarma({ anomalias: evaluacion, gasto, nombreSensor: 'Cuadro principal', idSensor: '51', metrica: 'consumo' }))
console.log(motor.resumenAlarma({
    anomalias: evaluacion,
    gasto,
    modelo,
    nombreSensor: 'Cuadro principal',
    idRed: '2',
    idSensor: '51',
    metrica: 'consumo',
    unidades: 'kWh',
}))

console.log('\n--- texto de un dia sin novedades ---')
const gastoNormal = motor.evaluaGasto({ puntos: normales, modelo, costeMesAcumulado: 95, ahora: { ...hoy, h: 13 }, presupuestoMes: 300 })
console.log(motor.resumenAlarma({ anomalias: evaluacionNormal, gasto: gastoNormal, modelo, nombreSensor: 'Cuadro principal', idRed: '2', idSensor: '51', metrica: 'consumo', unidades: 'kWh' }))

// ---------------------------------------------------------------------------
console.log('\n=== 5. Sensor sin tarifa (sin coste) ===')
const sinCoste = normales.map((punto) => ({ ...punto, coste: null }))
const gastoSinCoste = motor.evaluaGasto({ puntos: sinCoste, modelo, costeMesAcumulado: null, ahora: hoy, presupuestoMes: null })
comprueba('no falla si no hay coste', gastoSinCoste.coste_hoy === 0 && gastoSinCoste.presupuesto === null, gastoSinCoste)

console.log(`\n${fallos === 0 ? 'TODO CORRECTO' : 'FALLOS: ' + fallos}`)
process.exit(fallos === 0 ? 0 : 1)
