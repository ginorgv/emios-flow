'use strict'

/**
 * Motor de alarmas adaptativas ("vivas") para EMIOS.
 *
 * Idea: en vez de programar un umbral fijo que hay que revisar cada mes, se
 * aprende el comportamiento NORMAL del sensor por franja de calendario
 * (dia de la semana + hora del dia). Como el modelo se recalcula sobre una
 * ventana movil de historial, la alarma se adapta sola al cambio de estacion,
 * a los cambios de habito y a los festivos.
 *
 * Sobre ese modelo se evalua cada lectura nueva:
 *   - desviacion estadistica (media, mediana, percentil 95 y desviacion tipica)
 *   - desviacion en DINERO (campo coste del API de EMIOS)
 *   - presupuesto mensual y proyeccion a fin de mes
 *
 * Todo lo de este fichero son funciones puras (sin red) para poder probarlas
 * en local con datos sinteticos antes de publicar la pieza.
 */

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
const CAMPOS_POR_DEFECTO = ['incremento', 'consumo', 'coste']
const DIAS_MES_MEDIO = 30.44

// ---------------------------------------------------------------------------
// Fechas (se trabaja con hora local "de pared", como hace EMIOS)
// ---------------------------------------------------------------------------

function dosDigitos(numero) {
    return String(numero).padStart(2, '0')
}

/** Acepta 'dd-mm-yyyy_HH:MM:SS' (formato de EMIOS) y tambien ISO 'yyyy-mm-dd HH:MM:SS'. */
function parseaFechaEmios(valor) {
    if (valor === undefined || valor === null) {
        return null
    }
    const limpio = String(valor).trim()

    let coincidencia = /^(\d{2})-(\d{2})-(\d{4})[_ ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(limpio)
    if (coincidencia) {
        return {
            y: Number(coincidencia[3]), mo: Number(coincidencia[2]), d: Number(coincidencia[1]),
            h: Number(coincidencia[4]), mi: Number(coincidencia[5]), s: Number(coincidencia[6] || 0),
        }
    }

    coincidencia = /^(\d{4})-(\d{2})-(\d{2})[T_ ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(limpio)
    if (coincidencia) {
        return {
            y: Number(coincidencia[1]), mo: Number(coincidencia[2]), d: Number(coincidencia[3]),
            h: Number(coincidencia[4]), mi: Number(coincidencia[5]), s: Number(coincidencia[6] || 0),
        }
    }

    return null
}

/** Milisegundos "UTC" de una fecha de pared: sirve para sumar dias sin que afecte el horario de verano. */
function aMs(fecha) {
    return Date.UTC(fecha.y, fecha.mo - 1, fecha.d, fecha.h || 0, fecha.mi || 0, fecha.s || 0)
}

function deMs(ms) {
    const fecha = new Date(ms)
    return {
        y: fecha.getUTCFullYear(), mo: fecha.getUTCMonth() + 1, d: fecha.getUTCDate(),
        h: fecha.getUTCHours(), mi: fecha.getUTCMinutes(), s: fecha.getUTCSeconds(),
    }
}

function formateaFechaEmios(fecha) {
    return `${dosDigitos(fecha.d)}-${dosDigitos(fecha.mo)}-${fecha.y}_${dosDigitos(fecha.h)}:${dosDigitos(fecha.mi)}:${dosDigitos(fecha.s)}`
}

/** 0 = domingo ... 6 = sabado */
function diaDeLaSemana(fecha) {
    return new Date(Date.UTC(fecha.y, fecha.mo - 1, fecha.d)).getUTCDay()
}

/** Fecha y hora actual en horario espanol (EMIOS trabaja en hora local de Espana). */
function ahoraEnMadrid() {
    const partes = new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date())
    const valor = (tipo) => Number((partes.find((parte) => parte.type === tipo) || {}).value)
    return {
        y: valor('year'), mo: valor('month'), d: valor('day'),
        h: valor('hour') % 24, mi: valor('minute'), s: valor('second'),
    }
}

function sumaDias(fecha, dias) {
    const base = Date.UTC(fecha.y, fecha.mo - 1, fecha.d)
    return deMs(base + dias * 86400000)
}

function inicioDelDia(fecha) {
    return { y: fecha.y, mo: fecha.mo, d: fecha.d, h: 0, mi: 0, s: 0 }
}

function finDelDia(fecha) {
    return { y: fecha.y, mo: fecha.mo, d: fecha.d, h: 23, mi: 59, s: 59 }
}

function primerDiaDelMes(fecha) {
    return { y: fecha.y, mo: fecha.mo, d: 1, h: 0, mi: 0, s: 0 }
}

function diasDelMes(fecha) {
    return new Date(Date.UTC(fecha.y, fecha.mo, 0)).getUTCDate()
}

/**
 * Parte un rango en trozos de como maximo 'maxDias' dias, porque el API de
 * EMIOS no admite consultas de mas de 31 dias (366 en algunos intervalos).
 */
function parteEnVentanas(desde, hasta, maxDias = 31) {
    const ventanas = []
    let cursor = inicioDelDia(desde)
    const limite = aMs(hasta)
    let vueltas = 0

    while (aMs(cursor) <= limite && vueltas++ < 500) {
        const ultimoDia = sumaDias(cursor, maxDias - 1)
        const fin = Math.min(aMs(finDelDia(ultimoDia)), limite)
        ventanas.push({ desde: formateaFechaEmios(cursor), hasta: formateaFechaEmios(deMs(fin)) })
        cursor = sumaDias(cursor, maxDias)
    }

    return ventanas
}

// ---------------------------------------------------------------------------
// Numeros y estadistica
// ---------------------------------------------------------------------------

/** EMIOS devuelve los numeros como texto; admite "" (sin dato), "17.56" y "1.234,56". */
function numero(valor) {
    if (valor === null || valor === undefined) {
        return null
    }
    if (typeof valor === 'number') {
        return Number.isFinite(valor) ? valor : null
    }
    const limpio = String(valor).trim().replace(/\s/g, '')
    if (limpio === '' || limpio === '-' || limpio.toLowerCase() === 'null') {
        return null
    }
    const normalizado = (limpio.includes(',') && limpio.includes('.'))
        ? limpio.replace(/\./g, '').replace(',', '.')
        : limpio.replace(',', '.')
    const convertido = Number(normalizado)
    return Number.isFinite(convertido) ? convertido : null
}

/** Redondeo a 'decimales' cifras y devuelve numero (no texto). */
function redondea(valor, decimales = 2) {
    if (valor === null || valor === undefined || !Number.isFinite(valor)) {
        return null
    }
    const factor = 10 ** decimales
    return Math.round(valor * factor) / factor
}

/** Numero con coma decimal, para los textos en espanol. */
function formateaNumero(valor, decimales = 2) {
    if (valor === null || valor === undefined || !Number.isFinite(valor)) {
        return 'sin dato'
    }
    return valor.toFixed(decimales).replace('.', ',')
}

function mediana(ordenados) {
    const n = ordenados.length
    if (n === 0) {
        return null
    }
    const mitad = Math.floor(n / 2)
    return n % 2 === 0 ? (ordenados[mitad - 1] + ordenados[mitad]) / 2 : ordenados[mitad]
}

/** Percentil por interpolacion lineal sobre la lista ya ordenada. */
function percentil(ordenados, porcentaje) {
    const n = ordenados.length
    if (n === 0) {
        return null
    }
    if (n === 1) {
        return ordenados[0]
    }
    const posicion = (porcentaje / 100) * (n - 1)
    const inferior = Math.floor(posicion)
    const superior = Math.ceil(posicion)
    if (inferior === superior) {
        return ordenados[inferior]
    }
    return ordenados[inferior] + (ordenados[superior] - ordenados[inferior]) * (posicion - inferior)
}

function estadisticas(valores) {
    const n = valores.length
    if (n === 0) {
        return { n: 0, media: null, mediana: null, desviacion: null, p05: null, p95: null, min: null, max: null }
    }
    const ordenados = [...valores].sort((a, b) => a - b)
    const media = valores.reduce((suma, valor) => suma + valor, 0) / n
    const varianza = n > 1 ? valores.reduce((suma, valor) => suma + (valor - media) ** 2, 0) / (n - 1) : 0
    return {
        n,
        media: redondea(media, 4),
        mediana: redondea(mediana(ordenados), 4),
        desviacion: redondea(Math.sqrt(varianza), 4),
        p05: redondea(percentil(ordenados, 5), 4),
        p95: redondea(percentil(ordenados, 95), 4),
        min: redondea(ordenados[0], 4),
        max: redondea(ordenados[n - 1], 4),
    }
}

// ---------------------------------------------------------------------------
// Lectura de la respuesta de EMIOS
// ---------------------------------------------------------------------------

/**
 * Convierte la respuesta de dame_valores_rango_fechas_sensor.php en una lista
 * de puntos {fecha, dia, hora, valor, coste} usando el campo elegido como
 * metrica (incremento | consumo | coste).
 */
function extraePuntos(json, metrica = 'consumo') {
    const bloque = (json && json.valores_rango_fechas_sensor) ? json.valores_rango_fechas_sensor : (json || {})
    const campos = Array.isArray(bloque.campos) && bloque.campos.length > 0
        ? bloque.campos.map((campo) => String(campo).toLowerCase())
        : CAMPOS_POR_DEFECTO
    const tuplas = Array.isArray(bloque.tuplas_horas_valores) ? bloque.tuplas_horas_valores : []

    const indiceMetrica = campos.indexOf(String(metrica).toLowerCase())
    const indiceCoste = campos.indexOf('coste')

    const puntos = []
    let descartados = 0

    for (const tupla of tuplas) {
        const fecha = parseaFechaEmios(tupla.hora ?? tupla.fecha ?? tupla.fecha_hora)
        const valores = Array.isArray(tupla.tupla_valores) ? tupla.tupla_valores : []
        const valor = indiceMetrica >= 0 ? numero(valores[indiceMetrica]) : null

        if (!fecha || valor === null) {
            descartados++
            continue
        }

        puntos.push({
            fecha,
            ms: aMs(fecha),
            dia: diaDeLaSemana(fecha),
            hora: fecha.h,
            valor,
            coste: indiceCoste >= 0 ? numero(valores[indiceCoste]) : null,
        })
    }

    return { puntos, campos, descartados, tuplas: tuplas.length }
}

// ---------------------------------------------------------------------------
// Aprendizaje del perfil
// ---------------------------------------------------------------------------

/**
 * Construye el modelo del sensor: para cada franja (dia de la semana + hora)
 * guarda la media, la mediana, el percentil 95 y la desviacion tipica.
 * Ademas resume el gasto (campo coste) del periodo analizado.
 */
function aprendeModelo(puntos, metrica = 'consumo') {
    const porFranja = new Map()
    const porHora = new Map()

    for (const punto of puntos) {
        const clave = `${punto.dia}-${punto.hora}`
        if (!porFranja.has(clave)) {
            porFranja.set(clave, [])
        }
        porFranja.get(clave).push(punto.valor)

        // Perfil por hora del dia sumando todos los dias: sirve de respaldo cuando la
        // franja concreta (dia de la semana + hora) todavia tiene pocas muestras.
        if (!porHora.has(punto.hora)) {
            porHora.set(punto.hora, [])
        }
        porHora.get(punto.hora).push(punto.valor)
    }

    const franjas = {}
    for (const [clave, valores] of porFranja) {
        franjas[clave] = estadisticas(valores)
    }

    const horas = {}
    for (const [hora, valores] of porHora) {
        horas[hora] = estadisticas(valores)
    }

    const costes = puntos.map((punto) => punto.coste).filter((coste) => coste !== null)
    const dias = new Set(puntos.map((punto) => `${punto.fecha.y}-${punto.fecha.mo}-${punto.fecha.d}`)).size
    const costeTotal = costes.reduce((suma, coste) => suma + coste, 0)
    const costeMedioDia = dias > 0 ? costeTotal / dias : 0

    const primero = puntos.length > 0 ? puntos[0].fecha : null
    const ultimo = puntos.length > 0 ? puntos[puntos.length - 1].fecha : null

    return {
        version: 1,
        metrica,
        lecturas: puntos.length,
        dias,
        desde: primero ? formateaFechaEmios(primero) : null,
        hasta: ultimo ? formateaFechaEmios(ultimo) : null,
        generado: formateaFechaEmios(ahoraEnMadrid()),
        franjas,
        horas,
        global: estadisticas(puntos.map((punto) => punto.valor)),
        coste: {
            lecturas_con_coste: costes.length,
            total: redondea(costeTotal, 2),
            medio_dia: redondea(costeMedioDia, 4),
            medio_mes: redondea(costeMedioDia * DIAS_MES_MEDIO, 2),
        },
    }
}

/** Texto en espanol que resume el modelo aprendido (para el email o el chat). */
function resumenPerfil(modelo, { idRed, idSensor, nombreSensor } = {}) {
    const partes = []
    const sensor = nombreSensor ? `${nombreSensor} (red ${idRed} / sensor ${idSensor})` : `sensor ${idSensor} de la red ${idRed}`

    partes.push(`Perfil aprendido para el ${sensor}.`)
    partes.push(`Se han analizado ${modelo.lecturas} lecturas de ${modelo.dias} dias (${modelo.desde} a ${modelo.hasta}).`)
    partes.push(`Valor tipico de "${modelo.metrica}": ${formateaNumero(modelo.global.media)} de media (mediana ${formateaNumero(modelo.global.mediana)}).`)
    partes.push(`Franjas horarias con patron propio: ${Object.keys(modelo.franjas).length}.`)

    if (modelo.origen_coste === 'calculado' && modelo.coste.lecturas_con_coste > 0) {
        partes.push(`Gasto: ${formateaNumero(modelo.coste.total)} en el periodo, ${formateaNumero(modelo.coste.medio_dia)} al dia de media (estimado ${formateaNumero(modelo.coste.medio_mes)} al mes). Calculado con el precio indicado de ${formateaNumero(modelo.precio_energia, 4)} EUR por unidad.`)
    }
    else if (modelo.coste.lecturas_con_coste > 0) {
        partes.push(`Gasto segun EMIOS: ${formateaNumero(modelo.coste.total)} en el periodo, ${formateaNumero(modelo.coste.medio_dia)} al dia de media (estimado ${formateaNumero(modelo.coste.medio_mes)} al mes).`)
    }
    else {
        partes.push('El sensor no devuelve coste (revisa si tiene tarifa asignada en EMIOS o indica un precio por unidad).')
    }

    // Franjas mas "gastadoras" y mas "movidas", utilidad directa para el cliente
    const franjas = Object.entries(modelo.franjas)
        .filter(([, valor]) => valor.n >= 3 && valor.media !== null)
    if (franjas.length > 0) {
        const ordenadas = [...franjas].sort((a, b) => b[1].media - a[1].media)
        const ruidosas = [...franjas].sort((a, b) => (b[1].desviacion ?? 0) - (a[1].desviacion ?? 0))
        const describe = ([clave, valor]) => {
            const [dia, hora] = clave.split('-')
            return `${DIAS_SEMANA[Number(dia)]} a las ${dosDigitos(Number(hora))}:00 (${formateaNumero(valor.media)})`
        }
        partes.push(`Franjas de mayor consumo: ${ordenadas.slice(0, 3).map(describe).join(', ')}.`)
        partes.push(`Franjas mas irregulares: ${ruidosas.slice(0, 3).map(describe).join(', ')}.`)
    }

    return partes.join(' ')
}

// ---------------------------------------------------------------------------
// Evaluacion de la alarma
// ---------------------------------------------------------------------------

/**
 * Si EMIOS no trae el coste de cada lectura y el cliente indica su precio por
 * unidad (normalmente EUR/kWh), se calcula coste = valor x precio.
 * Asi las alertas en dinero funcionan aunque el sensor no tenga tarifa en EMIOS.
 */
function aplicaPrecio(puntos, precioEnergia) {
    const precio = numero(precioEnergia)
    if (precio === null || precio <= 0) {
        return puntos
    }
    return puntos.map((punto) => ({
        ...punto,
        coste: (punto.coste === null || punto.coste === undefined) ? punto.valor * precio : punto.coste,
    }))
}

/** Marca en el modelo de donde sale el dinero, para que los textos no enganen. */
function marcaOrigenCoste(modelo, precioEnergia) {
    const precio = numero(precioEnergia)
    modelo.origen_coste = (precio !== null && precio > 0) ? 'calculado' : 'emios'
    modelo.precio_energia = (precio !== null && precio > 0) ? precio : null
    return modelo
}

function clasificaGravedad(z, desviacionPorcentaje) {
    const zAbsoluto = Math.abs(z || 0)
    const desviacionAbsoluta = Math.abs(desviacionPorcentaje || 0)
    if (zAbsoluto >= 6 || desviacionAbsoluta >= 300) {
        return 'alta'
    }
    if (zAbsoluto >= 4 || desviacionAbsoluta >= 100) {
        return 'media'
    }
    return 'baja'
}

/**
 * Elige contra que se compara una lectura, en cascada:
 *   1. la franja exacta (dia de la semana + hora), lo ideal
 *   2. el perfil por hora del dia (sumando todos los dias)
 *   3. el perfil global del sensor
 * Asi el motor funciona desde el primer dia y se va afinando conforme
 * se acumula historial (con un ano entero, la franja ya tiene ~52 muestras).
 */
function eligeReferencia({ punto, modelo, minimoMuestras }) {
    const franjas = (modelo && modelo.franjas) || {}
    const horas = (modelo && modelo.horas) || {}

    const franja = franjas[`${punto.dia}-${punto.hora}`]
    if (franja && franja.n >= minimoMuestras && franja.media !== null) {
        return { referencia: 'franja', estadistica: franja }
    }

    const hora = horas[punto.hora]
    if (hora && hora.n >= minimoMuestras && hora.media !== null) {
        return { referencia: 'hora', estadistica: hora }
    }

    const global = (modelo && modelo.global) || null
    if (global && global.n >= minimoMuestras && global.media !== null) {
        return { referencia: 'global', estadistica: global }
    }

    return { referencia: null, estadistica: null }
}

/**
 * Compara las lecturas nuevas con el modelo. Una lectura se marca cuando:
 *   - sale del sobre historico de esa franja (por encima del percentil 95 o por debajo del 5), Y
 *   - se aleja de la media al menos 'umbralSigma' desviaciones tipicas (o, si la
 *     desviacion tipica es casi cero, al menos 'desviacionFuertePorcentaje'), Y
 *   - el cambio es relevante en porcentaje ('desviacionMinimaPorcentaje').
 * Los tres filtros juntos evitan los falsos avisos de un sensor muy regular.
 */
function evaluaAnomalias({ puntos, modelo, umbralSigma = 3, minimoMuestras = 3, desviacionMinimaPorcentaje = 15, desviacionFuertePorcentaje = 50 }) {
    const anomalias = []
    let sinReferencia = 0

    for (const punto of puntos) {
        const { referencia, estadistica } = eligeReferencia({ punto, modelo, minimoMuestras })
        if (!referencia) {
            sinReferencia++
            continue
        }

        const sigma = estadistica.desviacion
        const z = (sigma !== null && sigma > 0) ? (punto.valor - estadistica.media) / sigma : null
        const desviacionPorcentaje = estadistica.media > 0 ? ((punto.valor - estadistica.media) / estadistica.media) * 100 : null
        const tendencia = punto.valor >= estadistica.media ? 'alta' : 'baja'

        const fueraDelSobre = tendencia === 'alta'
            ? (estadistica.p95 !== null && punto.valor > estadistica.p95)
            : (estadistica.p05 !== null && punto.valor < estadistica.p05)
        const porSigma = z !== null && Math.abs(z) >= umbralSigma
        const porPorcentaje = desviacionPorcentaje !== null && Math.abs(desviacionPorcentaje) >= desviacionFuertePorcentaje
        const cambioRelevante = desviacionPorcentaje === null || Math.abs(desviacionPorcentaje) >= desviacionMinimaPorcentaje

        if (fueraDelSobre && (porSigma || porPorcentaje) && cambioRelevante) {
            anomalias.push({
                fecha: formateaFechaEmios(punto.fecha),
                dia: DIAS_SEMANA[punto.dia],
                hora: punto.hora,
                valor: redondea(punto.valor, 4),
                esperado: estadistica.media,
                mediana: estadistica.mediana,
                p95: estadistica.p95,
                p05: estadistica.p05,
                desviacion_tipica: sigma,
                z: z === null ? null : redondea(z, 2),
                desviacion_porcentaje: desviacionPorcentaje === null ? null : redondea(desviacionPorcentaje, 1),
                tendencia,
                referencia,
                muestras_referencia: estadistica.n,
                coste: punto.coste === null ? null : redondea(punto.coste, 4),
                gravedad: clasificaGravedad(z, desviacionPorcentaje),
            })
        }
    }

    anomalias.sort((a, b) => Math.abs(b.z || 0) - Math.abs(a.z || 0) || Math.abs(b.desviacion_porcentaje || 0) - Math.abs(a.desviacion_porcentaje || 0))

    return {
        anomalias,
        sin_referencia: sinReferencia,
        evaluadas: puntos.length - sinReferencia,
    }
}

/**
 * Parte economica: gasto del dia, comparacion con lo habitual, gasto acumulado
 * del mes y proyeccion a fin de mes frente al presupuesto del cliente.
 */
function evaluaGasto({ puntos, modelo, costeMesAcumulado = null, ahora, presupuestoMes = null }) {
    const hoy = ahora || ahoraEnMadrid()
    const delDia = puntos.filter((punto) => punto.coste !== null && punto.fecha.y === hoy.y && punto.fecha.mo === hoy.mo && punto.fecha.d === hoy.d)
    const costeHoy = delDia.reduce((suma, punto) => suma + punto.coste, 0)
    const medioDia = modelo && modelo.coste ? modelo.coste.medio_dia : null

    const desviacionPorcentaje = (medioDia && medioDia > 0 && delDia.length > 0)
        ? ((costeHoy - medioDia) / medioDia) * 100
        : null

    const diasConMes = diasDelMes(hoy)
    const diaActual = hoy.d
    const proyeccionMes = (costeMesAcumulado !== null && diaActual > 0)
        ? (costeMesAcumulado / diaActual) * diasConMes
        : null

    let presupuesto = null
    if (presupuestoMes !== null && presupuestoMes !== undefined && Number(presupuestoMes) > 0) {
        const objetivo = Number(presupuestoMes)
        presupuesto = {
            objetivo,
            consumido: redondea(costeMesAcumulado, 2),
            consumido_porcentaje: costeMesAcumulado === null ? null : redondea((costeMesAcumulado / objetivo) * 100, 1),
            proyeccion_mes: redondea(proyeccionMes, 2),
            supera_presupuesto: proyeccionMes !== null && proyeccionMes > objetivo,
            exceso_previsto: proyeccionMes === null ? null : redondea(proyeccionMes - objetivo, 2),
            ya_superado: costeMesAcumulado !== null && costeMesAcumulado > objetivo,
        }
    }

    return {
        lecturas_con_coste: delDia.length,
        coste_hoy: redondea(costeHoy, 2),
        coste_medio_dia_historico: redondea(medioDia, 2),
        desviacion_porcentaje: desviacionPorcentaje === null ? null : redondea(desviacionPorcentaje, 1),
        coste_mes_acumulado: costeMesAcumulado === null ? null : redondea(costeMesAcumulado, 2),
        proyeccion_mes: redondea(proyeccionMes, 2),
        presupuesto,
    }
}

/** Texto en espanol con el veredicto, listo para el asunto/cuerpo del aviso. */
function resumenAlarma({ anomalias, gasto, modelo, nombreSensor, idRed, idSensor, metrica, unidades }) {
    const sensor = nombreSensor ? `${nombreSensor}` : `sensor ${idSensor}`
    const unidad = unidades ? ` ${unidades}` : ''
    const lineas = []

    if (anomalias.anomalias.length > 0) {
        const principal = anomalias.anomalias[0]
        const cuando = `${principal.dia} a las ${dosDigitos(principal.hora)}:00`
        const sentido = principal.tendencia === 'baja' ? 'inferior' : 'superior'
        const conQue = principal.referencia === 'franja'
            ? 'lo habitual para esa franja'
            : (principal.referencia === 'hora' ? 'lo habitual a esa hora (esa franja aun tiene pocas muestras)' : 'lo habitual en este sensor')
        lineas.push(`ALARMA ADAPTATIVA: el ${sensor} se sale de su comportamiento normal.`)
        lineas.push(`El ${cuando} el valor de "${metrica}" fue ${formateaNumero(principal.valor)}${unidad}, ${sentido} a ${conQue} (${formateaNumero(principal.esperado)}${unidad}: ${principal.desviacion_porcentaje !== null && principal.desviacion_porcentaje >= 0 ? '+' : ''}${formateaNumero(principal.desviacion_porcentaje, 0)}%).`)
        if (anomalias.anomalias.length > 1) {
            lineas.push(`Hay ${anomalias.anomalias.length} franjas fuera de lo normal en el periodo revisado; la mas grave es esta.`)
        }
    }
    else {
        lineas.push(`Sin novedades: el ${sensor} se comporta dentro de lo normal para esta epoca del ano.`)
        if (anomalias.evaluadas > 0) {
            lineas.push(`Se han revisado ${anomalias.evaluadas} lecturas contra su perfil habitual.`)
        }
    }

    if (gasto && gasto.lecturas_con_coste > 0) {
        let frase = `Gasto de hoy: ${formateaNumero(gasto.coste_hoy)} EUR`
        if (gasto.coste_medio_dia_historico) {
            frase += ` (habitual ${formateaNumero(gasto.coste_medio_dia_historico)} EUR`
            if (gasto.desviacion_porcentaje !== null) {
                frase += `, ${gasto.desviacion_porcentaje >= 0 ? '+' : ''}${formateaNumero(gasto.desviacion_porcentaje, 0)}%`
            }
            frase += ')'
        }
        lineas.push(`${frase}.`)
        if (gasto.origen_coste === 'calculado' && gasto.precio_energia) {
            lineas.push(`El coste esta calculado con tu precio de ${formateaNumero(gasto.precio_energia, 4)} EUR por unidad (EMIOS no devuelve coste para este sensor).`)
        }
    }

    if (gasto && gasto.presupuesto) {
        const presupuesto = gasto.presupuesto
        let frase = `Presupuesto mensual: llevas ${formateaNumero(presupuesto.consumido)} de ${formateaNumero(presupuesto.objetivo)} EUR`
        if (presupuesto.consumido_porcentaje !== null) {
            frase += ` (${formateaNumero(presupuesto.consumido_porcentaje, 0)}%)`
        }
        if (presupuesto.proyeccion_mes !== null) {
            frase += `. A este ritmo acabaras el mes en ${formateaNumero(presupuesto.proyeccion_mes)} EUR`
            if (presupuesto.supera_presupuesto) {
                frase += `, es decir ${formateaNumero(presupuesto.exceso_previsto)} EUR por encima del presupuesto`
            }
        }
        lineas.push(`${frase}.`)
    }

    return lineas.join(' ')
}

/** Asunto del aviso, corto y con lo importante delante. */
function asuntoAlarma({ anomalias, gasto, nombreSensor, idSensor, metrica }) {
    const sensor = nombreSensor ? nombreSensor : `sensor ${idSensor}`
    if (gasto && gasto.presupuesto && gasto.presupuesto.supera_presupuesto) {
        return `[EMIOS] ${sensor}: vas a superar el presupuesto (${formateaNumero(gasto.presupuesto.proyeccion_mes, 0)} EUR)`
    }
    if (anomalias.anomalias.length > 0) {
        const principal = anomalias.anomalias[0]
        return `[EMIOS] ${sensor}: ${metrica} fuera de lo normal (${principal.desviacion_porcentaje >= 0 ? '+' : ''}${formateaNumero(principal.desviacion_porcentaje, 0)}%)`
    }
    return `[EMIOS] ${sensor}: todo en orden`
}

module.exports = {
    DIAS_SEMANA,
    CAMPOS_POR_DEFECTO,
    parseaFechaEmios,
    formateaFechaEmios,
    diaDeLaSemana,
    ahoraEnMadrid,
    sumaDias,
    inicioDelDia,
    finDelDia,
    primerDiaDelMes,
    diasDelMes,
    parteEnVentanas,
    numero,
    redondea,
    formateaNumero,
    mediana,
    percentil,
    estadisticas,
    extraePuntos,
    aprendeModelo,
    resumenPerfil,
    aplicaPrecio,
    marcaOrigenCoste,
    eligeReferencia,
    evaluaAnomalias,
    evaluaGasto,
    resumenAlarma,
    asuntoAlarma,
}
