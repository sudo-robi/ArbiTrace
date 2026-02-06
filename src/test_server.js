import express from 'express'
import bodyParser from 'body-parser'
import { analyzeCrossChainCausality, computeCausalGraph } from './causalityAnalyzer.js'

const app = express()
app.use(bodyParser.json())

app.post('/__test/analyze', (req, res) => {
  try {
    const payload = req.body || {}
    const detection = payload.detection || {}
    const retryable = payload.retryable || null
    const l2Receipt = (detection && detection.l2Receipt) || payload.l2Receipt || null
    const failureReason = payload.failureReason || 'UNKNOWN'
    const failureMessage = payload.failureMessage || null

    const causality = analyzeCrossChainCausality(detection, retryable, l2Receipt, failureReason, failureMessage)
    const graph = computeCausalGraph(detection, retryable ? [retryable] : [], l2Receipt)

    return res.json({ ok: true, crossChainCausality: causality, causalGraph: graph })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

const PORT = process.env.TEST_PORT || 3456
const server = app.listen(PORT, () => console.log(`test-server:${PORT}`))

// export for graceful shutdown if imported
export default server
