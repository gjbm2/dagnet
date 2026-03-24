import pytensor
import pytensor.tensor as pt
import numpy as np

F1 = pt.scalar('F1')
F2 = pt.scalar('F2')
F3 = pt.scalar('F3')
F4 = pt.scalar('F4')

kappa = 10.0
p = 0.5

a1 = kappa * p * (F2 - F1)
a2 = kappa * p * (F3 - F2)
a3 = kappa * p * (F4 - F3)

logp = (pt.gammaln(0 + a1) - pt.gammaln(a1)) + \
       (pt.gammaln(0 + a2) - pt.gammaln(a2)) + \
       (pt.gammaln(2 + a3) - pt.gammaln(a3))

grad = pt.grad(logp, [F1, F2, F3, F4])

f = pytensor.function([F1, F2, F3, F4], grad)

print("grad:", f(0.1, 0.2, 0.3, 0.4))
