'use strict'

// Comprobacion local de la pieza antes de subirla a EMIOS Flow.
const pieza = require('./src/index.js').emios

console.log('clase del objeto  :', pieza.constructor.name, '(debe ser "Piece")')
console.log('metadata          :', JSON.stringify(pieza.metadata(), null, 1))

console.log('--- conexion ---')
console.log('tipo:', pieza.auth.type, '| obligatoria:', pieza.auth.required, '| nombre:', pieza.auth.displayName)
for (const [clave, prop] of Object.entries(pieza.auth.props)) {
    console.log(`  ${clave}: ${prop.type} (obligatorio=${prop.required})${prop.defaultValue !== undefined ? ' porDefecto=' + prop.defaultValue : ''}`)
}

console.log('--- acciones ---')
const acciones = pieza.actions()
for (const [nombre, accion] of Object.entries(acciones)) {
    console.log(`  ${nombre} | ${accion.displayName} | requiereAuth=${accion.requireAuth}`)
    for (const [clave, prop] of Object.entries(accion.props)) {
        const aviso = prop && prop.type ? '' : '  <-- SIN TYPE!'
        console.log(`      ${clave}: ${prop && prop.type}${prop && prop.refreshers ? ' refreshers=' + JSON.stringify(prop.refreshers) : ''}${aviso}`)
    }
}
console.log('--- triggers ---')
console.log('  ', Object.keys(pieza.triggers()).length, 'triggers')
