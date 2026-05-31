import React from 'react'
import ReactDOM from 'react-dom/client'
import OntologyGenerator from './ontology-generator/OntologyGenerator'

const el = document.getElementById('root')
if (!el) throw new Error('Root element #root not found')

ReactDOM.createRoot(el).render(
  <React.StrictMode>
    <OntologyGenerator />
  </React.StrictMode>,
)
