import pymc as pm
import pytensor
import pytensor.tensor as pt
import numpy as np

# We need to run the test harness up to the point where the model is built,
# then get the initial point and evaluate the gradient.

