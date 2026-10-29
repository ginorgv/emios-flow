'use strict'

/**
 * Pieza de EMIOS para EMIOS Flow (Activepieces).
 *
 * Permite consultar la plataforma EMIOS desde un flujo: redes, sensores,
 * valores actuales, historico por fechas y simulacion de factura.
 *
 * Los desplegables de red, sensor y tarifa se rellenan en vivo llamando al API
 * de EMIOS, para no tener que escribir identificadores a mano.
 */

const { createPiece, createAction, Property, PieceAuth } = require('@activepieces/pieces-framework')

const {
    BASE_POR_DEFECTO,
    llamarEmios,
    extraeLista,
    opcionesDeLista,
    dropdownConError,
} = require('./lib/emios-api')

const {
    ahoraEnMadrid,
    sumaDias,
    inicioDelDia,
    finDelDia,
    primerDiaDelMes,
    parteEnVentanas,
    formateaFechaEmios,
    parseaFechaEmios,
    extraePuntos,
    aprendeModelo,
    resumenPerfil,
    aplicaPrecio,
    marcaOrigenCoste,
    evaluaAnomalias,
    evaluaGasto,
    resumenAlarma,
    asuntoAlarma,
} = require('./lib/adaptativo')

const CLAVES_ETIQUETA_RED = ['nombre', 'nombre_red', 'descripcion', 'descripcion_red', 'red', 'clave', 'id_red']
const CLAVES_VALOR_RED = ['id_red', 'id', 'clave', 'red']
const CLAVES_ETIQUETA_SENSOR = ['nombre', 'nombre_sensor', 'descripcion', 'sensor', 'direccion', 'clave', 'id_sensor']
const CLAVES_VALOR_SENSOR = ['id_sensor', 'id', 'clave', 'sensor']
const CLAVES_ETIQUETA_TARIFA = ['nombre', 'nombre_tarifa', 'descripcion', 'tarifa', 'clave', 'id_tarifa']
const CLAVES_VALOR_TARIFA = ['id_tarifa', 'id', 'clave', 'tarifa']

// ----------------------------------------------------------------------------
// Conexion
// ----------------------------------------------------------------------------

const emiosAuth = PieceAuth.CustomAuth({
    displayName: 'Conexion EMIOS',
    required: true,
    description: 'Servidor de EMIOS y credenciales del API externo. Se recomienda crear un usuario de API dedicado por cliente.',
    props: {
        baseUrl: Property.ShortText({
            displayName: 'URL del servidor EMIOS',
            description: 'Sin barra final. Ejemplo: https://emios-v6-production.up.railway.app',
            required: true,
            defaultValue: BASE_POR_DEFECTO,
        }),
        usuario: Property.ShortText({
            displayName: 'Usuario del API',
            required: true,
        }),
        contrasenya: PieceAuth.SecretText({
            displayName: 'Contrasena del API',
            required: true,
        }),
    },
})

// ----------------------------------------------------------------------------
// Desplegables en vivo
// ----------------------------------------------------------------------------

const redDropdown = () => Property.Dropdown({
    displayName: 'Red',
    description: 'Red de EMIOS a la que pertenece el sensor',
    required: true,
    refreshers: [],
    options: async (propsValue) => {
        try {
            const json = await llamarEmios({
                auth: propsValue.auth,
                endpoint: 'dame_redes_usuario.php',
            })
            const lista = extraeLista(json, ['redes', 'lista_redes', 'dame_redes_usuario'])
            const opciones = opcionesDeLista(lista, CLAVES_ETIQUETA_RED, CLAVES_VALOR_RED)
            if (opciones.length === 0) {
                return dropdownConError('EMIOS no devolvio ninguna red para este usuario')
            }
            return { disabled: false, options: opciones }
        }
        catch (error) {
            return dropdownConError(`No se pudieron cargar las redes: ${error.message}`)
        }
    },
})

const sensorDropdown = () => Property.Dropdown({
    displayName: 'Sensor',
    description: 'Sensor de la red seleccionada',
    required: true,
    refreshers: ['id_red'],
    options: async (propsValue) => {
        const idRed = propsValue.id_red
        if (!idRed) {
            return dropdownConError('Elige primero la red')
        }
        try {
            const json = await llamarEmios({
                auth: propsValue.auth,
                endpoint: 'dame_sensores.php',
                parametros: { id_red: idRed },
            })
            const lista = extraeLista(json, ['sensores', 'lista_sensores', 'dame_sensores'])
            const opciones = opcionesDeLista(lista, CLAVES_ETIQUETA_SENSOR, CLAVES_VALOR_SENSOR)
            if (opciones.length === 0) {
                return dropdownConError('Esta red no tiene sensores')
            }
            return { disabled: false, options: opciones }
        }
        catch (error) {
            return dropdownConError(`No se pudieron cargar los sensores: ${error.message}`)
        }
    },
})

const tarifaDropdown = () => Property.Dropdown({
    displayName: 'Tarifa',
    description: 'Tarifa asociada al sensor',
    required: true,
    refreshers: ['id_red', 'id_sensor'],
    options: async (propsValue) => {
        const idRed = propsValue.id_red
        const idSensor = propsValue.id_sensor
        if (!idRed || !idSensor) {
            return dropdownConError('Elige primero la red y el sensor')
        }
        try {
            const json = await llamarEmios({
                auth: propsValue.auth,
                endpoint: 'dame_tarifa_sensor.php',
                parametros: { id_red: idRed, id_sensor: idSensor },
            })
            const lista = extraeLista(json, ['tarifas', 'lista_tarifas', 'dame_tarifa_sensor'])
            let opciones = opcionesDeLista(lista, CLAVES_ETIQUETA_TARIFA, CLAVES_VALOR_TARIFA)
            // EMIOS devuelve un unico objeto ('tarifa_sensor') cuando el sensor tiene tarifa asignada
            if (opciones.length === 0 && json.tarifa_sensor && typeof json.tarifa_sensor === 'object') {
                opciones = opcionesDeLista([json.tarifa_sensor], CLAVES_ETIQUETA_TARIFA, CLAVES_VALOR_TARIFA)
            }
            if (opciones.length === 0) {
                const sinTarifa = json.sensor_sin_tarifa === true || json.tarifa_sensor === null
                return dropdownConError(sinTarifa
                    ? 'Este sensor no tiene tarifa asignada en EMIOS'
                    : 'No se pudieron leer las tarifas de este sensor')
            }
            return { disabled: false, options: opciones }
        }
        catch (error) {
            return dropdownConError(`No se pudieron cargar las tarifas: ${error.message}`)
        }
    },
})

// ----------------------------------------------------------------------------
// Propiedades compartidas
// ----------------------------------------------------------------------------

const fechaHoraInicio = () => Property.ShortText({
    displayName: 'Fecha y hora de inicio',
    description: 'Formato de EMIOS: dd-mm-yyyy_HH:MM:SS  (ejemplo: 03-06-2024_00:00:00)',
    required: true,
})

const fechaHoraFin = () => Property.ShortText({
    displayName: 'Fecha y hora de fin',
    description: 'Formato de EMIOS: dd-mm-yyyy_HH:MM:SS  (ejemplo: 04-06-2024_23:00:00)',
    required: true,
})

const intervaloValores = () => Property.StaticDropdown({
    displayName: 'Intervalo de valores',
    description: 'Agrupacion de los valores devueltos. "tiempo_real" siempre esta disponible; el resto depende de la configuracion del sensor en EMIOS.',
    required: true,
    defaultValue: 'hora',
    options: {
        options: [
            { label: 'Tiempo real', value: 'tiempo_real' },
            { label: 'Cada hora', value: 'hora' },
            { label: 'Cada dia', value: 'dia' },
            { label: 'Cada semana', value: 'semana' },
            { label: 'Cada mes', value: 'mes' },
            { label: 'Cada cuarto de hora', value: 'cuartohora' },
        ],
    },
})

// ----------------------------------------------------------------------------
// Acciones
// ----------------------------------------------------------------------------

const listarRedes = createAction({
    name: 'listar_redes',
    displayName: 'Listar redes',
    description: 'Devuelve las redes de EMIOS a las que tiene acceso el usuario del API',
    props: {},
    run: async (context) => {
        const json = await llamarEmios({ auth: context.auth, endpoint: 'dame_redes_usuario.php' })
        return {
            ...json,
            lista_redes: extraeLista(json, ['redes', 'lista_redes', 'dame_redes_usuario']),
        }
    },
})

const listarSensores = createAction({
    name: 'listar_sensores',
    displayName: 'Listar sensores',
    description: 'Devuelve los sensores de una red de EMIOS',
    props: {
        id_red: redDropdown(),
    },
    run: async (context) => {
        const json = await llamarEmios({
            auth: context.auth,
            endpoint: 'dame_sensores.php',
            parametros: { id_red: context.propsValue.id_red },
        })
        return {
            ...json,
            lista_sensores: extraeLista(json, ['sensores', 'lista_sensores', 'dame_sensores']),
        }
    },
})

const valoresActuales = createAction({
    name: 'valores_actuales',
    displayName: 'Valores actuales de un sensor',
    description: 'Ultimo valor disponible del sensor (tiempo real e intervalos procesados)',
    props: {
        id_red: redDropdown(),
        id_sensor: sensorDropdown(),
    },
    run: async (context) => {
        return llamarEmios({
            auth: context.auth,
            endpoint: 'dame_valores_actuales_sensor.php',
            parametros: {
                id_red: context.propsValue.id_red,
                id_sensor: context.propsValue.id_sensor,
            },
        })
    },
})

const historicoValores = createAction({
    name: 'historico_valores',
    displayName: 'Historico de valores',
    description: 'Valores del sensor entre dos fechas. Limites de EMIOS: 31 dias por consulta (366 en algunos intervalos) y 50.000 valores',
    props: {
        id_red: redDropdown(),
        id_sensor: sensorDropdown(),
        fecha_hora_inicio: fechaHoraInicio(),
        fecha_hora_fin: fechaHoraFin(),
        intervalo_valores: intervaloValores(),
    },
    run: async (context) => {
        return llamarEmios({
            auth: context.auth,
            endpoint: 'dame_valores_rango_fechas_sensor.php',
            parametros: {
                id_red: context.propsValue.id_red,
                id_sensor: context.propsValue.id_sensor,
                fecha_hora_inicio: context.propsValue.fecha_hora_inicio,
                fecha_hora_fin: context.propsValue.fecha_hora_fin,
                intervalo_valores: context.propsValue.intervalo_valores,
            },
        })
    },
})

const simularFactura = createAction({
    name: 'simular_factura',
    displayName: 'Simular factura',
    description: 'Simula la factura del sensor con una tarifa de EMIOS',
    props: {
        id_red: redDropdown(),
        id_sensor: sensorDropdown(),
        id_tarifa: tarifaDropdown(),
        fecha_hora_inicio: fechaHoraInicio(),
        fecha_hora_fin: fechaHoraFin(),
    },
    run: async (context) => {
        return llamarEmios({
            auth: context.auth,
            endpoint: 'dame_simulacion_factura_sensor_tarifa.php',
            parametros: {
                id_red: context.propsValue.id_red,
                id_sensor: context.propsValue.id_sensor,
                id_tarifa: context.propsValue.id_tarifa,
                fecha_hora_inicio: context.propsValue.fecha_hora_inicio,
                fecha_hora_fin: context.propsValue.fecha_hora_fin,
            },
        })
    },
})

// ----------------------------------------------------------------------------
// Alarmas adaptativas ("vivas") y alertas de gasto
// ----------------------------------------------------------------------------

const metricaDropdown = () => Property.StaticDropdown({
    displayName: 'Magnitud a vigilar',
    description: 'Que se analiza en cada franja horaria.',
    required: true,
    defaultValue: 'consumo',
    options: {
        options: [
            { label: 'Consumo', value: 'consumo' },
            { label: 'Gasto en euros (coste)', value: 'coste' },
            { label: 'Incremento', value: 'incremento' },
        ],
    },
})

/** Lee el historial del sensor en trozos (el API no admite mas de 31 dias por consulta). */
async function leeHistorial({ auth, idRed, idSensor, desde, hasta, intervalo, metrica }) {
    const ventanas = parteEnVentanas(desde, hasta, 31)
    const puntos = []
    let descartados = 0
    const tramos = []

    for (const ventana of ventanas) {
        const json = await llamarEmios({
            auth,
            endpoint: 'dame_valores_rango_fechas_sensor.php',
            parametros: {
                id_red: idRed,
                id_sensor: idSensor,
                fecha_hora_inicio: ventana.desde,
                fecha_hora_fin: ventana.hasta,
                intervalo_valores: intervalo,
            },
        })
        const extraido = extraePuntos(json, metrica)
        puntos.push(...extraido.puntos)
        descartados += extraido.descartados
        tramos.push({ desde: ventana.desde, hasta: ventana.hasta, lecturas: extraido.puntos.length })

        // El API de EMIOS permite 60 consultas por minuto: margen entre tramos.
        if (ventanas.length > 1) {
            await new Promise((resolver) => setTimeout(resolver, 250))
        }
    }

    puntos.sort((a, b) => a.ms - b.ms)
    return { puntos, descartados, tramos, ventanas: ventanas.length }
}

/** Acepta el modelo como objeto o como texto JSON (para encadenar pasos). */
function normalizaModelo(valor) {
    if (!valor) {
        throw new Error('Falta el perfil aprendido: usa la salida "modelo" del paso "Aprender el perfil"')
    }
    if (typeof valor === 'string') {
        return JSON.parse(valor)
    }
    return valor
}

/** Nombre del sensor, solo para los textos (si falla, no rompe la accion). */
async function nombreDelSensor({ auth, idRed, idSensor }) {
    try {
        const json = await llamarEmios({ auth, endpoint: 'dame_sensores.php', parametros: { id_red: idRed } })
        const lista = extraeLista(json, ['sensores', 'lista_sensores', 'dame_sensores'])
        const encontrado = lista.find((sensor) => String(sensor.id_sensor ?? sensor.id ?? sensor.clave) === String(idSensor))
        return encontrado ? (encontrado.nombre || encontrado.nombre_sensor || null) : null
    }
    catch (error) {
        return null
    }
}

const aprenderPerfil = createAction({
    name: 'aprender_perfil',
    displayName: 'Aprender el perfil del sensor (alarma viva)',
    description: 'Analiza el historial y construye el perfil normal del sensor por franja horaria (dia de la semana + hora). Ese perfil es lo que hace que la alarma se adapte sola a cada epoca del ano, sin reprogramar nada. Recomendado: ejecutarlo una vez al dia o a la semana.',
    props: {
        id_red: redDropdown(),
        id_sensor: sensorDropdown(),
        metrica: metricaDropdown(),
        dias_historial: Property.Number({
            displayName: 'Dias de historial',
            description: 'Con 30 dias ya aprende el perfil semanal; con 365 aprende ademas la estacionalidad del ano. Se ignora si rellenas las fechas de abajo.',
            required: true,
            defaultValue: 30,
        }),
        fecha_hora_inicio: Property.ShortText({
            displayName: 'Fecha y hora de inicio (opcional)',
            description: 'Formato dd-mm-yyyy_HH:MM:SS. Si la rellenas junto con la fecha de fin, se analiza ese periodo en vez de los ultimos dias.',
            required: false,
        }),
        fecha_hora_fin: Property.ShortText({
            displayName: 'Fecha y hora de fin (opcional)',
            description: 'Formato dd-mm-yyyy_HH:MM:SS.',
            required: false,
        }),
        precio_energia: Property.Number({
            displayName: 'Precio por unidad (opcional)',
            description: 'Por ejemplo EUR/kWh. Si las lecturas de EMIOS no traen coste, se calcula coste = valor x precio para poder avisar en dinero.',
            required: false,
        }),
        intervalo_valores: intervaloValores(),
    },
    run: async (context) => {
        const idRed = context.propsValue.id_red
        const idSensor = context.propsValue.id_sensor
        const metrica = context.propsValue.metrica
        const dias = Math.max(1, Math.min(400, Number(context.propsValue.dias_historial) || 30))
        const ahora = ahoraEnMadrid()
        const inicioExplicito = parseaFechaEmios(context.propsValue.fecha_hora_inicio)
        const finExplicito = parseaFechaEmios(context.propsValue.fecha_hora_fin)
        const usaFechas = Boolean(inicioExplicito && finExplicito)
        const hasta = usaFechas ? finExplicito : finDelDia(ahora)
        const desde = usaFechas ? inicioExplicito : inicioDelDia(sumaDias(ahora, -dias))

        const { puntos, descartados, tramos } = await leeHistorial({
            auth: context.auth,
            idRed,
            idSensor,
            desde,
            hasta,
            intervalo: context.propsValue.intervalo_valores || 'hora',
            metrica,
        })

        if (puntos.length === 0) {
            throw new Error(`EMIOS no devolvio lecturas para el sensor ${idSensor} en el periodo indicado. Revisa las fechas, el intervalo de valores ('${context.propsValue.intervalo_valores || 'hora'}') y que el sensor tenga datos.`)
        }

        const precio = context.propsValue.precio_energia
        const puntosConPrecio = aplicaPrecio(puntos, precio)
        const modelo = marcaOrigenCoste(aprendeModelo(puntosConPrecio, metrica), precio)
        const nombre = await nombreDelSensor({ auth: context.auth, idRed, idSensor })

        return {
            ok: true,
            id_red: idRed,
            id_sensor: idSensor,
            nombre_sensor: nombre,
            metrica,
            lecturas: puntos.length,
            descartados,
            tramos,
            precio_energia_aplicado: modelo.precio_energia,
            modelo,
            modelo_json: JSON.stringify(modelo),
            resumen: resumenPerfil(modelo, { idRed, idSensor, nombreSensor: nombre }),
        }
    },
})

const comprobarAlarma = createAction({
    name: 'comprobar_alarma',
    displayName: 'Comprobar alarma adaptativa y gasto',
    description: 'Compara las ultimas lecturas con el perfil aprendido y con el presupuesto del cliente. Devuelve si hay que avisar, las desviaciones detectadas, el gasto de hoy y la proyeccion de fin de mes.',
    props: {
        id_red: redDropdown(),
        id_sensor: sensorDropdown(),
        metrica: metricaDropdown(),
        modelo: Property.Json({
            displayName: 'Perfil aprendido',
            description: 'Salida "modelo" del paso "Aprender el perfil".',
            required: true,
        }),
        horas_a_revisar: Property.Number({
            displayName: 'Horas a revisar',
            description: 'Cuantas horas atras se comparan con el perfil. Se ignora si rellenas las fechas de abajo.',
            required: true,
            defaultValue: 24,
        }),
        fecha_hora_inicio: Property.ShortText({
            displayName: 'Fecha y hora de inicio a revisar (opcional)',
            description: 'Formato dd-mm-yyyy_HH:MM:SS. Con la fecha de fin, revisa ese periodo concreto.',
            required: false,
        }),
        fecha_hora_fin: Property.ShortText({
            displayName: 'Fecha y hora de fin a revisar (opcional)',
            description: 'Formato dd-mm-yyyy_HH:MM:SS.',
            required: false,
        }),
        presupuesto_mes: Property.Number({
            displayName: 'Presupuesto mensual (EUR)',
            description: 'Opcional. Si se indica, avisa cuando el mes vaya camino de superarlo.',
            required: false,
        }),
        umbral_sigma: Property.Number({
            displayName: 'Sensibilidad (desviaciones tipicas)',
            description: 'Por defecto 3. Bajalo a 2 para avisos mas sensibles.',
            required: true,
            defaultValue: 3,
        }),
        minimo_muestras: Property.Number({
            displayName: 'Minimo de muestras por franja',
            description: 'Si una franja tiene menos muestras, se compara con el perfil por hora del dia.',
            required: true,
            defaultValue: 3,
        }),
        precio_energia: Property.Number({
            displayName: 'Precio por unidad (opcional)',
            description: 'Por ejemplo EUR/kWh. Si las lecturas no traen coste, se calcula coste = valor x precio (debe coincidir con el empleado al aprender el perfil).',
            required: false,
        }),
        intervalo_valores: intervaloValores(),
    },
    run: async (context) => {
        const idRed = context.propsValue.id_red
        const idSensor = context.propsValue.id_sensor
        const metrica = context.propsValue.metrica
        const modelo = normalizaModelo(context.propsValue.modelo)
        const horas = Math.max(1, Math.min(400, Number(context.propsValue.horas_a_revisar) || 24))
        const ahora = ahoraEnMadrid()
        const intervalo = context.propsValue.intervalo_valores || 'hora'
        const inicioExplicito = parseaFechaEmios(context.propsValue.fecha_hora_inicio)
        const finExplicito = parseaFechaEmios(context.propsValue.fecha_hora_fin)
        const usaFechas = Boolean(inicioExplicito && finExplicito)
        const desde = usaFechas ? inicioExplicito : inicioDelDia(sumaDias(ahora, -Math.ceil(horas / 24)))
        const hasta = usaFechas ? finExplicito : finDelDia(ahora)
        const { puntos: puntosBrutos } = await leeHistorial({
            auth: context.auth,
            idRed,
            idSensor,
            desde,
            hasta,
            intervalo,
            metrica,
        })
        const precio = context.propsValue.precio_energia
        const puntos = aplicaPrecio(puntosBrutos, precio)

        const evaluacion = evaluaAnomalias({
            puntos,
            modelo,
            umbralSigma: Number(context.propsValue.umbral_sigma) || 3,
            minimoMuestras: Number(context.propsValue.minimo_muestras) || 3,
        })

        // Gasto acumulado del mes de la fecha de referencia, para proyectar a fin de mes.
        const referencia = hasta
        const { puntos: puntosMes } = await leeHistorial({
            auth: context.auth,
            idRed,
            idSensor,
            desde: primerDiaDelMes(referencia),
            hasta: referencia,
            intervalo,
            metrica,
        })
        const costeMes = aplicaPrecio(puntosMes, precio).reduce((suma, punto) => suma + (punto.coste || 0), 0)

        const gasto = evaluaGasto({
            puntos,
            modelo,
            costeMesAcumulado: costeMes,
            ahora: referencia,
            presupuestoMes: context.propsValue.presupuesto_mes,
        })
        gasto.origen_coste = modelo.origen_coste === 'calculado' ? 'calculado' : 'emios'
        gasto.precio_energia = modelo.precio_energia

        const hayAnomalia = evaluacion.anomalias.length > 0
        const superaPresupuesto = Boolean(gasto.presupuesto && gasto.presupuesto.supera_presupuesto)
        const nombre = await nombreDelSensor({ auth: context.auth, idRed, idSensor })

        return {
            hay_alarma: hayAnomalia || superaPresupuesto,
            hay_anomalia: hayAnomalia,
            supera_presupuesto: superaPresupuesto,
            gravedad: hayAnomalia ? evaluacion.anomalias[0].gravedad : 'baja',
            total_anomalias: evaluacion.anomalias.length,
            anomalias: evaluacion.anomalias.slice(0, 10),
            lecturas_revisadas: puntos.length,
            sin_referencia: evaluacion.sin_referencia,
            id_red: idRed,
            id_sensor: idSensor,
            nombre_sensor: nombre,
            metrica,
            gasto,
            resumen: resumenAlarma({
                anomalias: evaluacion,
                gasto,
                modelo,
                nombreSensor: nombre,
                idRed,
                idSensor,
                metrica,
            }),
            asunto: asuntoAlarma({ anomalias: evaluacion, gasto, nombreSensor: nombre, idSensor, metrica }),
        }
    },
})

const consultarEmios = createAction({
    name: 'consultar_emios',
    displayName: 'Consulta avanzada al API de EMIOS',
    description: 'Llama a cualquier endpoint del API externo de EMIOS y devuelve el JSON tal cual. Util para endpoints que todavia no tienen accion propia.',
    props: {
        endpoint: Property.ShortText({
            displayName: 'Endpoint',
            description: 'Ejemplo: dame_valores_actuales_sensor.php',
            required: true,
        }),
        parametros: Property.Json({
            displayName: 'Parametros adicionales',
            description: 'Objeto JSON con los parametros del endpoint (no incluyas usuario ni contrasena: van en la conexion).',
            required: false,
        }),
    },
    run: async (context) => {
        const parametros = typeof context.propsValue.parametros === 'string'
            ? JSON.parse(context.propsValue.parametros || '{}')
            : (context.propsValue.parametros || {})
        return llamarEmios({
            auth: context.auth,
            endpoint: String(context.propsValue.endpoint).trim(),
            parametros,
        })
    },
})

// ----------------------------------------------------------------------------
// Pieza
// ----------------------------------------------------------------------------

const emios = createPiece({
    displayName: 'EMIOS',
    description: 'Plataforma EMIOS de gestion energetica: redes, sensores, valores y simulacion de factura',
    logoUrl: 'https://app-production-e0fdb.up.railway.app/brand/emios-icon.svg',
    authors: ['Energy Minus'],
    auth: emiosAuth,
    // Categorias del catalogo: "Energia" no existe, asi que se agrupa donde la buscaria
    // un cliente de EMIOS (analisis de datos y facturacion).
    categories: ['BUSINESS_INTELLIGENCE', 'ACCOUNTING'],
    minimumSupportedRelease: '0.0.0',
    actions: [
        listarRedes,
        listarSensores,
        valoresActuales,
        historicoValores,
        simularFactura,
        aprenderPerfil,
        comprobarAlarma,
        consultarEmios,
    ],
    triggers: [],
})

module.exports = {
    emios,
}
