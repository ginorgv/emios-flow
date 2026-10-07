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
// Pieza
// ----------------------------------------------------------------------------

const emios = createPiece({
    displayName: 'EMIOS',
    description: 'Plataforma EMIOS de gestion energetica: redes, sensores, valores y simulacion de factura',
    logoUrl: 'https://app-production-e0fdb.up.railway.app/brand/emios-icon.png',
    authors: ['Energy Minus'],
    auth: emiosAuth,
    minimumSupportedRelease: '0.0.0',
    actions: [
        listarRedes,
        listarSensores,
        valoresActuales,
        historicoValores,
        simularFactura,
    ],
    triggers: [],
})

module.exports = {
    emios,
}
