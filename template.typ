#import "@preview/quarto-support:0.1.0": *

// Define how to show a div with the class "indent"
#show div.where(classes.contains("indent")): it => {
  // Apply a block-level inset to the content
  block(inset: (left: 3em), it.body)
}