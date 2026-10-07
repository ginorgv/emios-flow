'use strict'

// Comprueba que las credenciales se leen en las dos formas posibles.
const { normalizaCredenciales } = require('./src/lib/emios-api')

const envuelta = { type: 'CUSTOM_AUTH', props: { usuario: 'rvazquez', contrasenya: 'secreta' } }
const plana = { baseUrl: 'https://mi-emios.ejemplo', usuario: 'otro', contrasenya: 'otra' }

console.log('envuelta ->', JSON.stringify(normalizaCredenciales(envuelta)))
console.log('plana    ->', JSON.stringify(normalizaCredenciales(plana)))
console.log('vacia    ->', JSON.stringify(normalizaCredenciales(undefined)))
