'use strict'

/**
 * Cliente del API externo de EMIOS.
 *
 * El API de EMIOS es un conjunto de ficheros PHP bajo /src/api/<nombre>.php que:
 *   - solo aceptan GET
 *   - se autentican con los parametros 'usuario' y 'contrasenya'
 *   - devuelven siempre un JSON con { resultado: 'OK' | 'ERROR', id_error?, ... }
 *
 * Aqui se centraliza la llamada, el control de errores y la lectura tolerante de
 * las listas (cada endpoint de EMIOS nombra sus arrays de una forma distinta).
 */

const BASE_POR_DEFECTO = 'https://emios-v6-production.up.railway.app'

function normalizaBase(baseUrl) {
    const base = String(baseUrl || BASE_POR_DEFECTO).trim()
    return base.replace(/\/+$/, '')
}

/**
 * La plataforma entrega la conexion de dos formas: con los props sueltos
 * ({usuario, contrasenya}) o envueltos ({props: {usuario, contrasenya}}).
 * Se aceptan las dos para no depender de ese detalle interno.
 */
function normalizaCredenciales(auth) {
    const props = (auth && typeof auth === 'object' && auth.props && typeof auth.props === 'object')
        ? auth.props
        : (auth || {})
    return {
        baseUrl: props.baseUrl || props.url || BASE_POR_DEFECTO,
        usuario: props.usuario || props.user || props.email,
        contrasenya: props.contrasenya || props.contrasena || props.password,
    }
}

function construyeUrl({ auth, endpoint, parametros }) {
    const credenciales = normalizaCredenciales(auth)
    const url = new URL(`${normalizaBase(credenciales.baseUrl)}/src/api/${endpoint}`)
    const todos = { usuario: credenciales.usuario, contrasenya: credenciales.contrasenya, ...(parametros || {}) }
    for (const [clave, valor] of Object.entries(todos)) {
        if (valor === undefined || valor === null || valor === '') {
            continue
        }
        url.searchParams.set(clave, String(valor))
    }
    return url
}

/**
 * Llama a un endpoint de EMIOS y devuelve el cuerpo JSON ya validado.
 * Lanza un error legible si no se puede conectar, si la respuesta no es JSON
 * o si EMIOS contesta con resultado != OK.
 */
async function llamarEmios({ auth, endpoint, parametros }) {
    const credenciales = normalizaCredenciales(auth)
    if (!credenciales.usuario || !credenciales.contrasenya) {
        throw new Error('Falta la conexion con EMIOS: configura el usuario y la contrasena')
    }

    const url = construyeUrl({ auth, endpoint, parametros })

    let respuesta
    try {
        respuesta = await fetch(url.toString(), {
            method: 'GET',
            headers: { Accept: 'application/json' },
        })
    }
    catch (error) {
        throw new Error(`No se pudo contactar con EMIOS en "${normalizaBase(credenciales.baseUrl)}" (${endpoint}): ${error.message}`)
    }

    const texto = await respuesta.text()

    let json
    try {
        json = JSON.parse(texto)
    }
    catch (error) {
        throw new Error(`EMIOS (${endpoint}) no devolvio JSON. HTTP ${respuesta.status}: ${texto.slice(0, 300).replace(/\s+/g, ' ')}`)
    }

    if (json.resultado !== 'OK') {
        const detalle = json.id_error !== undefined ? ` (id_error=${json.id_error})` : ''
        throw new Error(`EMIOS (${endpoint}) devolvio resultado=${json.resultado ?? 'desconocido'}${detalle}`)
    }

    return json
}

/**
 * EMIOS no es consistente con los nombres de las listas. Busca el array de datos:
 * primero en las claves habituales y, si no, el array mas grande de los dos
 * primeros niveles del JSON.
 */
function extraeLista(json, clavesPreferidas) {
    for (const clave of clavesPreferidas || []) {
        if (Array.isArray(json[clave])) {
            return json[clave]
        }
    }

    const candidatos = []
    const revisa = (objeto, profundidad) => {
        if (profundidad > 2 || objeto === null || typeof objeto !== 'object') {
            return
        }
        for (const valor of Object.values(objeto)) {
            if (Array.isArray(valor)) {
                candidatos.push(valor)
            }
            else if (valor !== null && typeof valor === 'object') {
                revisa(valor, profundidad + 1)
            }
        }
    }
    revisa(json, 0)

    if (candidatos.length === 0) {
        return []
    }
    candidatos.sort((a, b) => b.length - a.length)
    return candidatos[0]
}

/**
 * Convierte la lista de EMIOS en opciones de desplegable {label, value},
 * probando varios nombres de campo porque cada endpoint usa los suyos.
 */
function opcionesDeLista(lista, clavesEtiqueta, clavesValor) {
    const opciones = []

    for (const elemento of lista) {
        if (elemento === null || elemento === undefined) {
            continue
        }
        if (typeof elemento !== 'object') {
            opciones.push({ label: String(elemento), value: String(elemento) })
            continue
        }

        let etiqueta = null
        for (const clave of clavesEtiqueta) {
            const valor = elemento[clave]
            if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
                etiqueta = String(valor).trim()
                break
            }
        }

        let identificador = null
        for (const clave of clavesValor) {
            const valor = elemento[clave]
            if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
                identificador = String(valor).trim()
                break
            }
        }

        if (identificador === null) {
            continue
        }
        if (etiqueta === null) {
            etiqueta = identificador
        }
        opciones.push({
            label: etiqueta === identificador ? identificador : `${etiqueta} (${identificador})`,
            value: identificador,
        })
    }

    return opciones
}

/** Devuelve un desplegable deshabilitado con el motivo, en vez de romper la interfaz. */
function dropdownConError(mensaje) {
    return {
        disabled: true,
        options: [],
        placeholder: mensaje,
    }
}

module.exports = {
    BASE_POR_DEFECTO,
    llamarEmios,
    normalizaCredenciales,
    extraeLista,
    opcionesDeLista,
    dropdownConError,
    normalizaBase,
}
